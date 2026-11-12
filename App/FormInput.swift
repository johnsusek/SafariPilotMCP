import ApplicationServices
import Foundation

/// form_input: sets a text field, checkbox, radio or popup select by ref through AX, then reads the control back from the page.
extension Commands {
  func formInput(_ tabId: Int?, _ ref: Int, _ value: FormValue) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let control = try await inspect(tab.id, ref)

    switch control.kind {
    case .text:
      guard case let .text(text) = value else { throw Failure(description: "ref \(ref) is a text field, so value must be a string") }

      return try await setText(tab, ref, text)
    case .checkbox, .radio: return try await setChecked(tab, ref, control, value)
    case .select: return try await select(tab, ref, control, value)
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

  private func setText(_ tab: TabInfo, _ ref: Int, _ text: String) async throws -> CLIReply {
    let located = try await locateHittable(tab.id, ref)
    let match = try await AXEngine.resolve(located, tab: tab)
    let outcome = try AXEngine.type(text, into: match)
    // Secure fields read back one bullet per character.
    let expected = outcome.valueNode.subrole == kAXSecureTextFieldSubrole ? String(repeating: "\u{2022}", count: text.count) : text
    let matched = outcome.readBack == expected
    let lines = [
      "AXFocused=true on \(outcome.focused.summary): \(outcome.focusResult.name)",
      "AXValue on \(outcome.valueNode.summary): \(outcome.valueResult.name)",
      "read back: \(outcome.readBack.map { "\"\($0)\"" } ?? "nil") \(matched ? "(matches)" : "(DIFFERS)")",
    ] + matchLines(located, match)
    let data: JSONValue = .object([
      "tabId": .number(Double(tab.id)),
      "ref": .number(Double(ref)),
      "focusedRole": .string(outcome.focused.role),
      "focusResult": .string(outcome.focusResult.name),
      "valueRole": .string(outcome.valueNode.role),
      "valueResult": .string(outcome.valueResult.name),
      "readBack": outcome.readBack.map { .string($0) } ?? .null,
    ])
    let ok = outcome.focusResult == .success && outcome.valueResult == .success && matched
    return CLIReply(ok: ok, text: lines.joined(separator: "\n"), data: data)
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
    let (pressed, _) = try AXEngine.press(match)
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
    let (item, result) = try AXEngine.selectOption(index, label: option.label, in: match)

    guard result == .success else { throw Failure(description: "AXSelected=true on \(item.summary) failed: \(result.name)") }

    let after = try await settled(tab.id, ref) { $0.selectedIndex == index }

    guard after.selectedIndex == index else {
      let shown = after.selectedIndex.flatMap { options.indices.contains($0) ? options[$0].label : nil } ?? "nothing"
      data["selectedIndex"] = after.selectedIndex.map { .number(Double($0)) } ?? .null
      let lines = ["set AXSelected=true on \(item.summary) but select ref \(ref) still shows \"\(shown)\""] + matchLines(located, match)
      return CLIReply(ok: false, text: lines.joined(separator: "\n"), data: .object(data))
    }

    return CLIReply(ok: true, text: "selected \"\(option.label)\" in select ref \(ref) via AXSelected on \(item.summary)", data: .object(data))
  }
}
