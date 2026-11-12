import ApplicationServices
import Foundation

/// form_input: sets a text field, checkbox, radio, popup select or date/time input by ref through AX, then reads the control back from the page.
extension Commands {
  func formInput(_ tabId: Int?, _ ref: Int, _ value: FormValue) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let control = try await inspect(tab.id, ref)

    switch control.kind {
    case .text:
      guard case let .text(text) = value else { throw Failure(description: "ref \(ref) is a text field, so value must be a string") }

      return try await setText(tab, ref, control.secure, text)
    case .checkbox, .radio: return try await setChecked(tab, ref, control, value)
    case .select: return try await select(tab, ref, control, value)
    case .date, .time, .dateTimeLocal:
      guard case let .text(text) = value else { throw Failure(description: "ref \(ref) is a \(control.kind.rawValue) input, so value must be a string") }

      return try await setDateTime(tab, ref, control.kind, text)
    case .listbox: throw Failure(description: "ref \(ref) is a multiple or list box select, which form_input does not support; click its options instead")
    case .other: throw Failure(description: "ref \(ref) is not a text field, checkbox, radio or select; use click or key")
    }
  }

  private func inspect(_ tabId: Int, _ ref: Int) async throws -> InspectResult {
    try await content(tabId, .inspect(ref: ref)).decode(InspectResult.self)
  }

  /// The page applies an AX action asynchronously, so the control is re-read for up to 500 ms until it shows the change.
  private func settled(_ tabId: Int, _ ref: Int, until done: (InspectResult) -> Bool) async throws -> InspectResult {
    var control = try await inspect(tabId, ref)

    for _ in 0 ..< 5 where !done(control) {
      try await Task.sleep(for: .milliseconds(100))
      control = try await inspect(tabId, ref)
    }

    return control
  }

  /// Reads the value back from the page rather than the AX element, which WebKit may replace mid-call when focus changes the field's role (YouTube's search box).
  private func setText(_ tab: TabInfo, _ ref: Int, _ secure: Bool, _ text: String) async throws -> CLIReply {
    let located = try await locateHittable(tab.id, ref)
    let match = try await AXEngine.resolve(located, tab: tab)
    let outcome = try AXEngine.type(text, into: match)
    let expected = secure ? String(repeating: "\u{2022}", count: text.count) : text
    let after = try await settled(tab.id, ref) { $0.value == expected }
    let matched = after.value == expected
    let lines = [
      "AXFocused=true on \(outcome.focused.summary): \(outcome.focusResult.name)",
      "AXValue on \(outcome.valueNode.summary): \(outcome.valueResult.name)",
      "read back: \(after.value.map { "\"\($0)\"" } ?? "nil") \(matched ? "(matches)" : "(DIFFERS)")",
    ] + matchLines(located, match)
    let data: JSONValue = .object([
      "tabId": .number(Double(tab.id)),
      "ref": .number(Double(ref)),
      "focusedRole": .string(outcome.focused.role),
      "focusResult": .string(outcome.focusResult.name),
      "valueRole": .string(outcome.valueNode.role),
      "valueResult": .string(outcome.valueResult.name),
      "readBack": after.value.map { .string($0) } ?? .null,
    ])
    return CLIReply(ok: matched, text: lines.joined(separator: "\n"), data: data)
  }

  private func setChecked(_ tab: TabInfo, _ ref: Int, _ control: InspectResult, _ value: FormValue) async throws -> CLIReply {
    let kind = control.kind.rawValue
    let wanted: Bool

    switch value {
    case let .checked(flag): wanted = flag
    case .text("true"): wanted = true
    case .text("false"): wanted = false
    case let .text(other): throw Failure(description: "ref \(ref) is a \(kind), so value must be true or false, not \"\(other)\"")
    }

    let state = { (checked: Bool?) in checked == true ? "checked" : "unchecked" }
    var data: [String: JSONValue] = ["tabId": .number(Double(tab.id)), "ref": .number(Double(ref)), "kind": .string(kind), "checked": .bool(wanted)]

    if control.checked == wanted { return CLIReply(ok: true, text: "\(kind) ref \(ref) is already \(state(wanted)); nothing pressed", data: .object(data)) }

    if control.kind == .radio, !wanted { throw Failure(description: "radio ref \(ref) cannot be unchecked directly; check another radio in its group") }

    let located = try await locateHittable(tab.id, ref)
    let match = try await AXEngine.resolve(located, tab: tab)
    let pressed = try AXEngine.press(match)
    let after = try await settled(tab.id, ref) { $0.checked == wanted }
    data["pressedRole"] = .string(pressed.role)

    guard after.checked == wanted else {
      data["checked"] = .bool(after.checked == true)
      let lines = ["pressed \(pressed.summary) but \(kind) ref \(ref) is still \(state(after.checked))"] + matchLines(located, match)
      return CLIReply(ok: false, text: lines.joined(separator: "\n"), data: .object(data))
    }

    return CLIReply(ok: true, text: "\(state(wanted)) \(kind) ref \(ref) by pressing \(pressed.summary)", data: .object(data))
  }

  private func select(_ tab: TabInfo, _ ref: Int, _ control: InspectResult, _ value: FormValue) async throws -> CLIReply {
    guard case let .text(wanted) = value else { throw Failure(description: "ref \(ref) is a select, so value must be an option's value or label") }

    let options = control.options ?? []
    let listed = options.map { "\"\($0.label)\"" }.joined(separator: ", ")

    guard let index = options.firstIndex(where: { $0.value == wanted }) ?? options.firstIndex(where: { $0.label == wanted }) else {
      throw Failure(description: "select ref \(ref) has no option whose value or label is \"\(wanted)\"; options: \(listed)")
    }

    let option = options[index]
    var data: [String: JSONValue] = ["tabId": .number(Double(tab.id)), "ref": .number(Double(ref)), "index": .number(Double(index)), "value": .string(option.value), "label": .string(option.label)]

    if control.selectedIndex == index { return CLIReply(ok: true, text: "select ref \(ref) already shows \"\(option.label)\"; nothing changed", data: .object(data)) }

    guard !option.disabled else { throw Failure(description: "option \"\(option.label)\" of select ref \(ref) is disabled") }

    let located = try await locateHittable(tab.id, ref)
    let match = try await AXEngine.resolve(located, tab: tab)
    let occurrence = options[..<index].filter { $0.label == option.label }.count
    let item = try await AXEngine.pickOption(option.label, occurrence: occurrence, in: match)
    let after = try await settled(tab.id, ref) { $0.selectedIndex == index }

    guard after.selectedIndex == index else {
      let shown = after.selectedIndex.flatMap { options.indices.contains($0) ? options[$0].label : nil } ?? "nothing"
      data["selectedIndex"] = after.selectedIndex.map { .number(Double($0)) } ?? .null
      let lines = ["pressed \(item.summary) in the open menu but select ref \(ref) still shows \"\(shown)\""] + matchLines(located, match)
      return CLIReply(ok: false, text: lines.joined(separator: "\n"), data: .object(data))
    }

    return CLIReply(ok: true, text: "selected \"\(option.label)\" in select ref \(ref) by pressing \(item.summary) in its menu", data: .object(data))
  }

  /// WebKit draws these inputs as separate AXIncrementor fields whose AXValue does not stick, so each field is focused and its digits typed as real keys; change fires when focus leaves, as after a person types.
  private func setDateTime(_ tab: TabInfo, _ ref: Int, _ kind: ControlKind, _ value: String) async throws -> CLIReply {
    let parts = try dateTimeParts(kind, value, ref)
    let located = try await locateHittable(tab.id, ref)
    let match = try await AXEngine.resolve(located, tab: tab)
    let fields = try AXEngine.dateTimeFields(in: match)
    let titles = fields.map { $0.string(kAXTitleAttribute) ?? "" }
    // The meridiem field is the one without a title.
    let twelveHour = titles.contains("")
    var pid: pid_t = 0
    AXUIElementGetPid(match.target.app.element, &pid)
    var poster = EventPoster(pid: pid, windowID: nil)
    var typed: [String] = []
    let hour = Int(parts["hour"] ?? "0") ?? 0

    for (field, title) in zip(fields, titles) {
      let text: String

      switch title {
      case "": text = hour < 12 ? "A" : "P"
      case "hour": text = String(format: "%02d", twelveHour ? (hour % 12 == 0 ? 12 : hour % 12) : hour)
      case "seconds": text = parts[title] ?? "00"
      case "milliseconds": text = parts[title] ?? "000"
      default:
        guard let part = parts[title] else { throw Failure(description: "ref \(ref) shows a field titled \"\(title)\" that \"\(value)\" has no part for; fields: \(titles.map { "\"\($0)\"" }.joined(separator: ", "))") }

        text = part
      }

      let focused = AXUIElementSetAttributeValue(field.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)

      guard focused == .success else { throw Failure(description: "AXFocused=true on \(field.summary) failed: \(focused.name)") }

      try await awaitFocus(field, in: match.target)

      for character in text {
        try await poster.key(KeyChord.typing(character))
        try await Task.sleep(for: .milliseconds(10))
      }

      typed.append("\(title.isEmpty ? "meridiem" : title) \(text)")
    }

    // A zero seconds or milliseconds part may or may not appear in the value, so both sides drop it before comparing.
    let trimmed = { (text: String?) in (text ?? "").replacing(/(:00)?(\.0+)?$/, with: "") }
    let after = try await settled(tab.id, ref) { trimmed($0.value) == trimmed(value) }
    let matched = trimmed(after.value) == trimmed(value)
    let lines = [
      "typed \(typed.joined(separator: ", ")) into \(kind.rawValue) ref \(ref)",
      "read back: \"\(after.value ?? "")\" \(matched ? "(matches)" : "(DIFFERS)")",
    ] + matchLines(located, match)
    let data: JSONValue = .object(["tabId": .number(Double(tab.id)), "ref": .number(Double(ref)), "kind": .string(kind.rawValue), "readBack": .string(after.value ?? "")])
    return CLIReply(ok: matched, text: lines.joined(separator: "\n"), data: data)
  }

  /// Splits an input value (YYYY-MM-DD, HH:MM[:SS[.mmm]], or both joined by T) into parts keyed by WebKit's field titles, hour in 24 h.
  private func dateTimeParts(_ kind: ControlKind, _ value: String, _ ref: Int) throws -> [String: String] {
    let formats: [ControlKind: String] = [.date: "YYYY-MM-DD", .time: "HH:MM or HH:MM:SS", .dateTimeLocal: "YYYY-MM-DDTHH:MM"]
    let bad = Failure(description: "ref \(ref) is a \(kind.rawValue) input, so value must look like \(formats[kind] ?? "?"), not \"\(value)\"")
    let pieces = value.split(separator: "T", omittingEmptySubsequences: false)

    guard pieces.count == (kind == .dateTimeLocal ? 2 : 1) else { throw bad }

    var parts: [String: String] = [:]

    if kind != .time {
      guard let found = pieces[0].wholeMatch(of: /(\d{4,6})-(\d{2})-(\d{2})/) else { throw bad }

      parts["year"] = String(found.1)
      parts["month"] = String(found.2)
      parts["day"] = String(found.3)
    }

    if kind != .date {
      guard let found = pieces[pieces.count - 1].wholeMatch(of: /(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/) else { throw bad }

      parts["hour"] = String(found.1)
      parts["minutes"] = String(found.2)
      parts["seconds"] = found.3.map(String.init)
      parts["milliseconds"] = found.4.map { String($0).padding(toLength: 3, withPad: "0", startingAt: 0) }
    }

    return parts
  }

  /// Safari moves AX focus asynchronously, so keys wait up to 1 s until the field itself is focused. Keys go to Safari's main window, so the field's window is made main first.
  private func awaitFocus(_ field: AXNode, in target: AXEngine.Target) async throws {
    let focused = { target.app.value(kAXFocusedUIElementAttribute).map { AXNode(element: $0 as! AXUIElement) } }
    let isMain = { target.window.value(kAXMainAttribute) as? Bool == true }

    if !isMain() { AXUIElementSetAttributeValue(target.window.element, kAXMainAttribute as CFString, kCFBooleanTrue) }

    for _ in 0 ..< 20 {
      if let node = focused(), CFEqual(node.element, field.element) { return }

      // A window opened unfocused in the background never reports a focused element though keys still reach the field; the read-back catches a miss.
      if focused() == nil, isMain() { return }

      try await Task.sleep(for: .milliseconds(50))
    }

    throw Failure(description: "set AXFocused on \(field.summary) but Safari reports focus on \(focused()?.summary ?? "nothing") in \(isMain() ? "the main window" : "a window that is not main"); no keys were posted to it")
  }
}
