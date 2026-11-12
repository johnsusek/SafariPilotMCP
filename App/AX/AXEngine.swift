import AppKit
import ApplicationServices

/// Finds Safari's visible web area and acts on page elements purely through AX: hit-test, AXPress, AXFocused, AXValue.
@MainActor
enum AXEngine {
  struct Target {
    let app: AXNode
    let window: AXNode
    let webArea: AXNode
    let scrollArea: AXNode?
    let webAreas: [AXNode]
  }

  struct Hit {
    let target: Target
    let screenPoint: CGPoint
    let viewportFrame: CGRect
    let zoom: Double
    let node: AXNode
    let chain: [AXNode]
  }

  static func target() throws -> Target {
    guard AXIsProcessTrusted() else { throw Failure(description: "Accessibility permission not granted to SafariPilot.app") }
    guard let safari = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first else { throw Failure(description: "Safari is not running") }

    let app = AXNode(element: AXUIElementCreateApplication(safari.processIdentifier))
    AXUIElementSetMessagingTimeout(app.element, 3)

    guard let windowRef = app.value(kAXMainWindowAttribute) else { throw Failure(description: "Safari has no main window (AXMainWindow missing)") }

    let window = AXNode(element: windowRef as! AXUIElement)
    let webAreas = findWebAreas(in: window)

    guard let webArea = webAreas.first else {
      throw Failure(description: "no AXWebArea under Safari's main window; top children: \(window.children.map(\.summary).joined(separator: ", "))")
    }

    let scrollArea = webArea.parent.flatMap { $0.role == kAXScrollAreaRole ? $0 : nil }
    return Target(app: app, window: window, webArea: webArea, scrollArea: scrollArea, webAreas: webAreas)
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

  static func hitTest(css point: CGPoint, viewport: Viewport) throws -> Hit {
    let target = try target()

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

    guard let chain = node.chain(upTo: target.webArea) else {
      let ancestry = sequence(first: node, next: \.parent).prefix(12).map(\.summary).joined(separator: " < ")
      throw Failure(description: "hit at \(format(screenPoint)) is outside the web area: \(ancestry)")
    }

    return Hit(target: target, screenPoint: screenPoint, viewportFrame: frame, zoom: zoom, node: node, chain: chain)
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

  static func type(_ text: String, into hit: Hit) throws -> TypeOutcome {
    guard let focused = hit.chain.first(where: { $0.isSettable(kAXFocusedAttribute) }) else {
      throw Failure(description: "no element from the hit up to the web area has a settable AXFocused:\n\(describe(hit.chain))")
    }

    let focusResult = AXUIElementSetAttributeValue(focused.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)

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
