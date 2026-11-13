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

  static func safari() throws -> AXNode {
    guard AXIsProcessTrusted() else { throw Failure(description: "Accessibility permission not granted to SafariPilot.app") }
    guard let safari = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first else { throw Failure(description: "Safari is not running") }
    guard !safari.isHidden else { throw Failure(description: "Safari is hidden; unhide it so AX can reach its windows") }

    let app = AXNode(element: AXUIElementCreateApplication(safari.processIdentifier))
    AXUIElementSetMessagingTimeout(app.element, 3)
    return app
  }

  static func windows(of app: AXNode) throws -> [AXNode] {
    let windows = (app.value(kAXWindowsAttribute) as? [AXUIElement] ?? []).map(AXNode.init)
    let roles = windows.map(\.role)

    // Seen live: Safari's AX reported every window, and its main and focused window, as the AXApplication itself, so walking them expanded the menu bar again and again.
    guard roles.allSatisfy({ $0 == kAXWindowRole }) else {
      throw Failure(description: "Safari's accessibility reports its windows with roles \(roles), not AXWindow, so no page can be reached through it; this is a fault in Safari, and quitting and reopening Safari clears it")
    }

    return windows
  }

  static func candidate(_ window: AXNode, urls: [String]) -> WindowCandidate {
    WindowCandidate(title: window.string(kAXTitleAttribute) ?? "", frame: window.frame, minimized: window.value(kAXMinimizedAttribute) as? Bool == true, urls: urls)
  }

  /// Finds the window showing the tab among all of Safari's AX windows; the tab must already be active in its window.
  static func target(for tab: TabInfo) async throws -> Target {
    let app = try safari()

    // WebKit builds a page's AX tree lazily and a just-selected tab takes a moment to appear, so a miss is retried for 1 s.
    var attempt = 0

    while true {
      let windows = try windows(of: app)
      let webAreas = windows.map { findWebAreas(in: $0) }
      let candidates = zip(windows, webAreas).map { window, areas in candidate(window, urls: areas.map { $0.string("AXURL") ?? "?" }) }

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
      let role = node.role

      if role == "AXWebArea" {
        found.append(node)
        continue
      }

      if role == kAXMenuBarRole || role == kAXMenuRole { continue }

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

    // WebKit moves a frame's AX elements a while after the frame scrolls (seen live: over a second), so an element inside a frame that matches nothing is searched again for up to 2 s.
    let patience = ContinuousClock.now + .seconds(located.ref.frames.isEmpty ? 0 : 2)
    var best: FrameMatching.Found<AXNode>?
    var visited = 0

    while true {
      // Pruning by frame is fast but misses positioned elements that overflow a smaller parent (Leaflet's map controls sit in 10 px tall panes), so a miss walks again without it.
      var (found, count) = try bestMatch(under: target.webArea, for: screenRect, prune: true)
      visited += count

      if (found?.score ?? 0) < FrameMatching.minimum {
        let (unpruned, more) = try bestMatch(under: target.webArea, for: screenRect, prune: false)
        visited += more

        if (unpruned?.score ?? 0) > (found?.score ?? 0) { found = unpruned }
      }

      best = found

      if (best?.score ?? 0) >= FrameMatching.minimum || ContinuousClock.now >= patience { break }

      try await Task.sleep(for: .milliseconds(150))
    }

    guard let best, best.score >= FrameMatching.minimum else {
      let found = best.map { "best was \($0.lineage[0].summary) \(format($0.lineage[0].frame)) scoring \(String(format: "%.2f", $0.score))" } ?? "no element under the web area has a frame"
      throw Failure(description: "no AX element matches the element's mapped frame \(format(screenRect)) (needs \(FrameMatching.minimum)); \(found) after \(visited) elements")
    }

    return Match(target: target, screenPoint: screenPoint, screenRect: screenRect, viewportFrame: frame, zoom: zoom, score: best.score, chain: best.lineage)
  }

  private static func bestMatch(under webArea: AXNode, for screenRect: CGRect, prune: Bool) throws -> (best: FrameMatching.Found<AXNode>?, visited: Int) {
    try FrameMatching.best(under: webArea.children, for: screenRect, prune: prune, limit: prune ? 5000 : 20000, children: \.children, frame: \.frame, role: \.role)
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

    // WebKit dispatches AXPress at the element's center, so a delegating ancestor (Booking's calendar month) would click whatever sits there instead.
    if let frame = node.frame, !match.screenRect.insetBy(dx: -1, dy: -1).contains(CGPoint(x: frame.midX, y: frame.midY)) {
      throw Failure(description: "the nearest element supporting AXPress is \(pressed.summary) \(format(frame)), \(depth) up from the match, and pressing it would click its center, outside the element at \(format(match.screenRect)); key Enter or Space with this ref may reach it from the keyboard:\n\(describe(match.chain))")
    }

    let error = AXUIElementPerformAction(node.element, kAXPressAction as CFString)

    guard error == .success else { throw Failure(description: "AXPress on \(pressed.summary) failed: \(error.name)") }

    return pressed
  }

  /// Sets AXFocused on the first element from the match up that allows it.
  static func focus(_ match: Match) throws -> (focused: AXNode, result: AXError) {
    guard let focused = match.chain.first(where: { $0.isSettable(kAXFocusedAttribute) }) else {
      throw Failure(description: "no element from the match up to the web area has a settable AXFocused:\n\(describe(match.chain))")
    }

    return (focused, AXUIElementSetAttributeValue(focused.element, kAXFocusedAttribute as CFString, kCFBooleanTrue))
  }

  /// Sets AXValue on the first element from the match up that allows it.
  static func setValue(_ text: String, in match: Match) throws -> (node: AXNode, result: AXError) {
    guard let node = match.chain.first(where: { $0.isSettable(kAXValueAttribute) }) else {
      throw Failure(description: "nothing from the match up to the web area has a settable AXValue:\n\(describe(match.chain))")
    }

    return (node, AXUIElementSetAttributeValue(node.element, kAXValueAttribute as CFString, text as CFString))
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
