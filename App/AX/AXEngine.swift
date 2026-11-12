import AppKit
import ApplicationServices

/// Finds the Safari window showing a tab and acts on page elements purely through AX: hit-test, AXRaise, AXPress, AXFocused, AXValue.
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

  struct Hit {
    let target: Target
    let screenPoint: CGPoint
    let viewportFrame: CGRect
    let zoom: Double
    let node: AXNode
    let chain: [AXNode]
  }

  /// The hit landed in another Safari window that covers the target.
  private struct Covered: Error { let by: String }

  /// Finds the window showing the tab among all of Safari's AX windows; the tab must already be active in its window.
  static func target(for tab: TabInfo) async throws -> Target {
    guard AXIsProcessTrusted() else { throw Failure(description: "Accessibility permission not granted to SafariPilot.app") }
    guard let safari = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first else { throw Failure(description: "Safari is not running") }
    guard !safari.isHidden else { throw Failure(description: "Safari is hidden; unhide it so its windows can be hit-tested") }

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

  /// Hit-tests the mapped point in the tab's window; when another Safari window covers it, raises the target and retries once.
  static func hitTest(css point: CGPoint, viewport: Viewport, tab: TabInfo) async throws -> Hit {
    let target = try await target(for: tab)

    do {
      return try hit(css: point, viewport: viewport, in: target)
    } catch let covered as Covered {
      let raised = AXUIElementPerformAction(target.window.element, kAXRaiseAction as CFString)

      guard raised == .success else { throw Failure(description: "target window is covered by \(covered.by) and AXRaise failed: \(raised.name)") }

      try await Task.sleep(for: .milliseconds(150))

      do {
        return try hit(css: point, viewport: viewport, in: target)
      } catch let still as Covered {
        throw Failure(description: "target window \(target.window.summary) is still covered by \(still.by) after AXRaise")
      }
    }
  }

  private static func hit(css point: CGPoint, viewport: Viewport, in target: Target) throws -> Hit {
    guard let webFrame = target.webArea.frame else { throw Failure(description: "AXWebArea has no frame") }
    guard viewport.innerWidth > 0 else { throw Failure(description: "viewport innerWidth is 0") }

    let frame = ViewportMapping.viewportFrame(webArea: webFrame, scrollArea: target.scrollArea?.frame)
    let zoom = ViewportMapping.zoom(viewport: viewport, frame: frame)
    let screenPoint = ViewportMapping.screenPoint(css: point, viewport: viewport, frame: frame)

    guard frame.contains(screenPoint) else {
      throw Failure(description: "mapped point \(format(screenPoint)) is outside the viewport frame \(format(frame)); element is probably off screen")
    }

    var hitElement: AXUIElement?
    let error = AXUIElementCopyElementAtPosition(target.app.element, Float(screenPoint.x), Float(screenPoint.y), &hitElement)

    guard error == .success, let hitElement else { throw Failure(description: "AXUIElementCopyElementAtPosition at \(format(screenPoint)) failed: \(error.name)") }

    let node = AXNode(element: hitElement)

    if let chain = node.chain(upTo: target.webArea) {
      return Hit(target: target, screenPoint: screenPoint, viewportFrame: frame, zoom: zoom, node: node, chain: chain)
    }

    if let window = node.value(kAXWindowAttribute).map({ AXNode(element: $0 as! AXUIElement) }), !CFEqual(window.element, target.window.element) {
      throw Covered(by: "\(window.summary) \(format(window.frame))")
    }

    let ancestry = sequence(first: node, next: \.parent).prefix(12).map(\.summary).joined(separator: " < ")
    throw Failure(description: "hit at \(format(screenPoint)) is outside the web area: \(ancestry)")
  }

  static func press(_ hit: Hit) throws -> (pressed: AXNode, depth: Int) {
    guard let depth = hit.chain.firstIndex(where: { $0.actions.contains(kAXPressAction) }) else {
      throw Failure(description: "no element from the hit up to the web area supports AXPress:\n\(describe(hit.chain))")
    }

    let pressed = hit.chain[depth]
    let error = AXUIElementPerformAction(pressed.element, kAXPressAction as CFString)

    guard error == .success else { throw Failure(description: "AXPress on \(pressed.summary) failed: \(error.name)") }

    return (pressed, depth)
  }

  struct TypeOutcome {
    let focused: AXNode
    let focusResult: AXError
    let valueNode: AXNode
    let valueResult: AXError
    let readBack: String?
  }

  /// Sets AXFocused on the first element from the hit up that allows it.
  static func focus(_ hit: Hit) throws -> (focused: AXNode, result: AXError) {
    guard let focused = hit.chain.first(where: { $0.isSettable(kAXFocusedAttribute) }) else {
      throw Failure(description: "no element from the hit up to the web area has a settable AXFocused:\n\(describe(hit.chain))")
    }

    return (focused, AXUIElementSetAttributeValue(focused.element, kAXFocusedAttribute as CFString, kCFBooleanTrue))
  }

  static func type(_ text: String, into hit: Hit) throws -> TypeOutcome {
    let (focused, focusResult) = try focus(hit)

    guard let valueNode = hit.chain.first(where: { $0.isSettable(kAXValueAttribute) }) else {
      throw Failure(description: "AXFocused set (\(focusResult.name)) but nothing has a settable AXValue:\n\(describe(hit.chain))")
    }

    let valueResult = AXUIElementSetAttributeValue(valueNode.element, kAXValueAttribute as CFString, text as CFString)
    return TypeOutcome(focused: focused, focusResult: focusResult, valueNode: valueNode, valueResult: valueResult, readBack: valueNode.string(kAXValueAttribute))
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
