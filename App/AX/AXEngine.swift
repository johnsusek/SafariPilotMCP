import AppKit
import ApplicationServices

/// Finds the Safari window showing a tab and acts on page elements purely through AX: frame matching, AXPress, AXFocused, AXValue.
@MainActor
enum AXEngine {
  struct Target {
    let app: AXNode
    let window: AXNode
    let webArea: AXNode
    let scrollArea: AXNode?
    let webAreas: [AXNode]
    let candidates: [WindowCandidate]
  }

  struct Match {
    let target: Target
    let screenPoint: CGPoint
    let screenRect: CGRect
    let viewportFrame: CGRect
    let zoom: Double
    let score: Double
    /// The matched element first, then its ancestors up to, not including, the web area.
    let chain: [AXNode]

    var node: AXNode { chain[0] }
  }

  /// Finds the window showing the tab among all of Safari's AX windows; the tab must already be active in its window.
  static func target(for tab: TabInfo) async throws -> Target {
    guard AXIsProcessTrusted() else { throw Failure(description: "Accessibility permission not granted to SafariPilot.app") }
    guard let safari = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first else { throw Failure(description: "Safari is not running") }
    guard !safari.isHidden else { throw Failure(description: "Safari is hidden; unhide it so AX can reach its windows") }

    let app = AXNode(element: AXUIElementCreateApplication(safari.processIdentifier))
    AXUIElementSetMessagingTimeout(app.element, 3)

    // WebKit builds a page's AX tree lazily and a just-selected tab takes a moment to appear, so a miss is retried for 1 s.
    var attempt = 0

    while true {
      let windows = (app.value(kAXWindowsAttribute) as? [AXUIElement] ?? []).map(AXNode.init)
      let webAreas = windows.map { findWebAreas(in: $0) }
      let candidates = zip(windows, webAreas).map { window, areas in
        WindowCandidate(title: window.string(kAXTitleAttribute) ?? "", frame: window.frame, minimized: window.value(kAXMinimizedAttribute) as? Bool == true, urls: areas.map { $0.string("AXURL") ?? "?" })
      }

      do {
        let index = try WindowMatching.match(tab: tab, candidates: candidates)
        let wanted = WindowMatching.normalize(tab.url)
        let webArea = webAreas[index].first { WindowMatching.normalize($0.string("AXURL") ?? "") == wanted }!
        let scrollArea = webArea.parent.flatMap { $0.role == kAXScrollAreaRole ? $0 : nil }
        return Target(app: app, window: windows[index], webArea: webArea, scrollArea: scrollArea, webAreas: webAreas[index], candidates: candidates)
      } catch .noMatch where attempt < 9 {
        attempt += 1
        try await Task.sleep(for: .milliseconds(100))
      } catch {
        throw Failure(description: error.description)
      }
    }
  }

  static func findWebAreas(in root: AXNode) -> [AXNode] {
    var found: [AXNode] = []
    var frontier: [(AXNode, Int)] = [(root, 0)]

    while let (node, depth) = frontier.popLast() {
      if node.role == "AXWebArea" {
        found.append(node)
        continue
      }

      if depth < 15 { frontier.append(contentsOf: node.children.reversed().map { ($0, depth + 1) }) }
    }

    return found
  }

  /// Resolves a located element to the AX element whose reported frame best matches its mapped screen rect; never hit-tests, so covering windows and a stale hit-test origin do not matter.
  static func resolve(_ located: LocateResult, tab: TabInfo) async throws -> Match {
    let target = try await target(for: tab)
    let viewport = located.viewport

    guard let webFrame = target.webArea.frame else { throw Failure(description: "AXWebArea has no frame") }
    guard viewport.innerWidth > 0 else { throw Failure(description: "viewport innerWidth is 0") }

    let frame = ViewportMapping.viewportFrame(webArea: webFrame, scrollArea: target.scrollArea?.frame)
    let zoom = ViewportMapping.zoom(viewport: viewport, frame: frame)
    let screenPoint = ViewportMapping.screenPoint(css: CGPoint(x: located.point.left, y: located.point.top), viewport: viewport, frame: frame)
    let screenRect = ViewportMapping.screenRect(css: located.rect, viewport: viewport, frame: frame)

    guard frame.contains(screenPoint) else {
      throw Failure(description: "mapped point \(format(screenPoint)) is outside the viewport frame \(format(frame)); element is probably off screen")
    }

    var best: (lineage: [AXNode], score: Double)?
    var frontier: [[AXNode]] = target.webArea.children.map { [$0] }
    var visited = 0

    // Lineages run from a node up to, not including, the web area. Subtrees whose frame misses the rect are skipped; empty or missing frames are still entered, since their children can lie outside them.
    while let lineage = frontier.popLast() {
      visited += 1

      guard visited <= 5000 else { throw Failure(description: "visited 5000 AX elements under the web area without finishing; page is too large to resolve by frame") }

      let node = lineage[0]
      let nodeFrame = node.frame

      if let nodeFrame, !nodeFrame.isEmpty, !nodeFrame.intersects(screenRect) { continue }

      if let nodeFrame {
        let score = FrameMatching.score(nodeFrame, screenRect)

        if FrameMatching.beats(score: score, depth: lineage.count, best: best.map { ($0.score, $0.lineage.count) }) { best = (lineage, score) }
      }

      frontier.append(contentsOf: node.children.reversed().map { [$0] + lineage })
    }

    guard let best, best.score >= FrameMatching.minimum else {
      let found = best.map { "best was \($0.lineage[0].summary) \(format($0.lineage[0].frame)) scoring \(String(format: "%.2f", $0.score))" } ?? "no element under the web area has a frame"
      throw Failure(description: "no AX element matches the element's mapped frame \(format(screenRect)) (needs \(FrameMatching.minimum)); \(found) after \(visited) elements")
    }

    return Match(target: target, screenPoint: screenPoint, screenRect: screenRect, viewportFrame: frame, zoom: zoom, score: best.score, chain: best.lineage)
  }

  /// What was pressed, read before pressing since a press that navigates leaves the element unreadable.
  struct Pressed {
    let summary: String
    let role: String
    let label: String
    let depth: Int
  }

  static func press(_ match: Match) throws -> Pressed {
    guard let depth = match.chain.firstIndex(where: { $0.actions.contains(kAXPressAction) }) else {
      throw Failure(description: "no element from the match up to the web area supports AXPress:\n\(describe(match.chain))")
    }

    let node = match.chain[depth]
    let pressed = Pressed(summary: node.summary, role: node.role, label: node.label, depth: depth)
    let error = AXUIElementPerformAction(node.element, kAXPressAction as CFString)

    guard error == .success else { throw Failure(description: "AXPress on \(pressed.summary) failed: \(error.name)") }

    return pressed
  }

  struct TypeOutcome {
    let focused: AXNode
    let focusResult: AXError
    let valueNode: AXNode
    let valueResult: AXError
    let readBack: String?
  }

  /// Sets AXFocused on the first element from the match up that allows it.
  static func focus(_ match: Match) throws -> (focused: AXNode, result: AXError) {
    guard let focused = match.chain.first(where: { $0.isSettable(kAXFocusedAttribute) }) else {
      throw Failure(description: "no element from the match up to the web area has a settable AXFocused:\n\(describe(match.chain))")
    }

    return (focused, AXUIElementSetAttributeValue(focused.element, kAXFocusedAttribute as CFString, kCFBooleanTrue))
  }

  static func type(_ text: String, into match: Match) throws -> TypeOutcome {
    let (focused, focusResult) = try focus(match)

    guard let valueNode = match.chain.first(where: { $0.isSettable(kAXValueAttribute) }) else {
      throw Failure(description: "AXFocused set (\(focusResult.name)) but nothing has a settable AXValue:\n\(describe(match.chain))")
    }

    let valueResult = AXUIElementSetAttributeValue(valueNode.element, kAXValueAttribute as CFString, text as CFString)
    return TypeOutcome(focused: focused, focusResult: focusResult, valueNode: valueNode, valueResult: valueResult, readBack: valueNode.string(kAXValueAttribute))
  }

  /// Opens a popup select's native menu with AXPress and presses the `occurrence`th AXMenuItem titled `label`; WebKit exposes the menu under the window only while it is open, and a closed popup has no AX children.
  static func pickOption(_ label: String, occurrence: Int, in match: Match) async throws -> AXNode {
    guard let popup = match.chain.first(where: { $0.role == kAXPopUpButtonRole }) else {
      throw Failure(description: "no AXPopUpButton from the match up to the web area:\n\(describe(match.chain))")
    }

    let opened = AXUIElementPerformAction(popup.element, kAXPressAction as CFString)

    guard opened == .success else { throw Failure(description: "AXPress on \(popup.summary) to open its menu failed: \(opened.name)") }

    var menu: AXNode?

    for _ in 0 ..< 20 {
      menu = openMenu(in: match.target.window)

      if menu != nil { break }

      try await Task.sleep(for: .milliseconds(50))
    }

    guard let menu else { throw Failure(description: "pressed \(popup.summary) but no open AXMenu appeared under \(match.target.window.summary) within 1 s") }

    let wanted = label.trimmingCharacters(in: .whitespaces)
    let items = menu.children.filter { $0.role == kAXMenuItemRole }
    let matching = items.filter { $0.label.trimmingCharacters(in: .whitespaces) == wanted }

    guard occurrence < matching.count else {
      AXUIElementPerformAction(menu.element, kAXCancelAction as CFString)
      throw Failure(description: "the open menu of \(popup.summary) has \(matching.count) items titled \"\(label)\", needed \(occurrence + 1); items: \(items.map { "\"\($0.label)\"" }.joined(separator: ", "))")
    }

    let item = matching[occurrence]
    let pressed = AXUIElementPerformAction(item.element, kAXPressAction as CFString)

    guard pressed == .success else {
      AXUIElementPerformAction(menu.element, kAXCancelAction as CFString)
      throw Failure(description: "AXPress on \(item.summary) in the open menu failed: \(pressed.name)")
    }

    return item
  }

  /// The open popup menu WebKit hangs under the window (AXSplitGroup > AXTabGroup > AXGroup > AXMenu), skipping the page and the menu bar.
  private static func openMenu(in window: AXNode) -> AXNode? {
    var frontier: [(AXNode, Int)] = [(window, 0)]

    while let (node, depth) = frontier.popLast() {
      if node.role == kAXMenuRole { return node }

      guard depth < 6, node.role != "AXWebArea", node.role != kAXMenuBarRole else { continue }

      frontier.append(contentsOf: node.children.map { ($0, depth + 1) })
    }

    return nil
  }

  /// The AXIncrementor fields of a date or time input in display order, each with its title and current value description.
  static func dateTimeFields(in match: Match) throws -> [AXNode] {
    guard let area = match.chain.first(where: { $0.role == "AXDateTimeArea" }) else {
      throw Failure(description: "no AXDateTimeArea from the match up to the web area:\n\(describe(match.chain))")
    }

    var fields: [AXNode] = []
    var stack = [area]

    while let node = stack.popLast() {
      if node.role == kAXIncrementorRole { fields.append(node) }

      stack.append(contentsOf: node.children.reversed())
    }

    return fields
  }

  static func describe(_ chain: [AXNode]) -> String {
    chain.map { "  \($0.summary) actions=[\($0.actions.joined(separator: ","))]" }.joined(separator: "\n")
  }

  static func format(_ point: CGPoint) -> String { String(format: "(%.1f, %.1f)", point.x, point.y) }
  static func format(_ rect: CGRect?) -> String {
    guard let rect else { return "none" }
    return String(format: "(%.1f, %.1f, %.1f x %.1f)", rect.minX, rect.minY, rect.width, rect.height)
  }
}
