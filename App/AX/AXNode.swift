import ApplicationServices

/// Thin typed reads over an AXUIElement.
struct AXNode: @unchecked Sendable {
  let element: AXUIElement

  func value(_ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
  }

  func string(_ attribute: String) -> String? {
    guard let value = value(attribute) else { return nil }
    if let string = value as? String { return string }
    if CFGetTypeID(value) == CFURLGetTypeID() { return (value as! URL).absoluteString }
    return nil
  }

  var role: String { string(kAXRoleAttribute) ?? "?" }
  var subrole: String? { string(kAXSubroleAttribute) }
  var parent: AXNode? { value(kAXParentAttribute).map { AXNode(element: $0 as! AXUIElement) } }
  var children: [AXNode] { (value(kAXChildrenAttribute) as? [AXUIElement] ?? []).map(AXNode.init) }

  /// Title, description, or value, whichever names the element first.
  var label: String {
    for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute] {
      if let text = string(attribute), !text.isEmpty { return String(text.prefix(80)) }
    }

    return ""
  }

  var frame: CGRect? {
    guard let position = value(kAXPositionAttribute), let size = value(kAXSizeAttribute) else { return nil }

    var origin = CGPoint.zero
    var extent = CGSize.zero
    AXValueGetValue(position as! AXValue, .cgPoint, &origin)
    AXValueGetValue(size as! AXValue, .cgSize, &extent)
    return CGRect(origin: origin, size: extent)
  }

  var actions: [String] {
    var names: CFArray?
    return AXUIElementCopyActionNames(element, &names) == .success ? (names as? [String] ?? []) : []
  }

  func isSettable(_ attribute: String) -> Bool {
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
  }

  /// Ancestors from this node up to, not including, `stop`; nil when `stop` is not an ancestor.
  func chain(upTo stop: AXNode) -> [AXNode]? {
    var nodes: [AXNode] = []
    var current: AXNode? = self

    while let node = current, nodes.count < 64 {
      if CFEqual(node.element, stop.element) { return nodes }

      nodes.append(node)
      current = node.parent
    }

    return nil
  }

  var summary: String {
    let name = label.isEmpty ? "" : " \"\(label)\""
    let subroleText = subrole.map { "/\($0)" } ?? ""
    return "\(role)\(subroleText)\(name)"
  }
}

extension AXError {
  var name: String {
    switch self {
    case .success: "success"
    case .failure: "failure"
    case .illegalArgument: "illegalArgument"
    case .invalidUIElement: "invalidUIElement"
    case .cannotComplete: "cannotComplete"
    case .attributeUnsupported: "attributeUnsupported"
    case .actionUnsupported: "actionUnsupported"
    case .apiDisabled: "apiDisabled (Accessibility not granted)"
    case .noValue: "noValue"
    case .notImplemented: "notImplemented"
    default: "AXError \(rawValue)"
    }
  }
}
