import ApplicationServices
import Foundation

/// form_input: sets a text field, checkbox or radio by ref through AX, and a popup select, date/time, slider or color input from the page script, then reads the control back from the page.
/// compat sets selects, date/time inputs and sliders through Safari's native menu and real keys instead, which brings the tab's window in front of the person's other Safari windows.
extension Commands {
  func formInput(_ tabId: Int?, _ ref: PageRef, _ value: FormValue, compat: Bool) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let control = try await inspect(tab.id, ref)

    switch control.kind {
    case .text:
      guard case let .text(text) = value else { throw Failure(.invalidArgument, "ref \(ref) is a text field, so value must be a string") }

      return try await setText(tab, ref, control.secure, text)
    case .checkbox, .radio: return try await setChecked(tab, ref, control, value)
    case .select: return try await select(tab, ref, control, value, compat: compat)
    case .date, .time, .dateTimeLocal:
      guard case let .text(text) = value else { throw Failure(.invalidArgument, "ref \(ref) is a \(control.kind.rawValue) input, so value must be a string") }

      let parts = try dateTimeParts(control.kind, text, ref)

      return compat ? try await setDateTime(tab, ref, control.kind, text, parts) : try await setPageValue(tab, ref, control.kind, text)
    case .color:
      guard case let .text(text) = value else { throw Failure(.invalidArgument, "ref \(ref) is a color input, so value must be a string such as #00ff00") }

      return try await setPageValue(tab, ref, .color, text)
    case .slider:
      guard case let .text(text) = value, let wanted = Double(text) else { throw Failure(.invalidArgument, "ref \(ref) is a slider, so value must be a number") }

      return try await setSlider(tab, ref, control, wanted, compat: compat)
    case .listbox: throw Failure(.invalidArgument, "ref \(ref) is a multiple or list box select, which form_input does not support; click its options instead")
    case .other: throw Failure(.invalidArgument, "ref \(ref) is not a text field, slider, checkbox, radio, select or color input; use click or key")
    }
  }

  private func inspect(_ tabId: Int, _ ref: PageRef) async throws -> InspectResult {
    try await content(tabId, .inspect(ref: ref)).decode(InspectResult.self)
  }

  /// The page applies an AX action asynchronously, so the control is re-read for up to 500 ms until it shows the change.
  private func settled(_ tabId: Int, _ ref: PageRef, until done: (InspectResult) -> Bool) async throws -> InspectResult {
    var control = try await inspect(tabId, ref)

    for _ in 0 ..< 5 where !done(control) {
      try await Timing.sleep(for: .milliseconds(100))
      control = try await inspect(tabId, ref)
    }

    return control
  }

  /// Reads the value back from the page rather than the AX element, which WebKit may replace mid-call when focus changes the field's role (YouTube's search box).
  private func setText(_ tab: TabInfo, _ ref: PageRef, _ secure: Bool, _ text: String) async throws -> CLIReply {
    let located = try await locateHittable(tab.id, ref, coveredOK: true)
    let match = try await AXEngine.resolve(located, tab: tab)
    let watch = await watchChanges(tab.id, ref)
    var focus = try await content(tab.id, .focus(ref: ref)).decode(FocusResult.self)
    var pressed: AXEngine.Pressed?

    // Safari refuses focus() in a cross-origin frame until it has had a real click, and a field without focus drops AXValue.
    if !focus.taken {
      pressed = try await Timing.measure("press") { try AXEngine.press(match) }
      focus = try await content(tab.id, .focus(ref: ref)).decode(FocusResult.self)
    }

    let (valueNode, valueResult) = try await Timing.measure("ax value") { try AXEngine.setValue(text, in: match) }
    let acted = ContinuousClock.now
    let expected = secure ? String(repeating: "\u{2022}", count: text.count) : text
    let after = try await settled(tab.id, ref) { $0.value == expected }
    let matched = after.value == expected
    let masked = secure ? ", one bullet per character because the field holds a secret" : ""
    let lines = (pressed.map { ["pressed \($0.summary) via AXPress first, as the page could not focus it"] } ?? []) + [
      "focused \(focus.focused) from the page",
      "AXValue on \(valueNode.summary): \(valueResult.name)",
      "read back: \(after.value.map { "\"\($0)\"" } ?? "nil") \(matched ? "(matches)" : "(DIFFERS)")\(masked)",
    ] + matchLines(located, match)
    let data: JSONValue = .object([
      "tabId": .number(Double(tab.id)),
      "ref": .string(ref.description),
      "focused": .string(focus.focused),
      "valueRole": .string(valueNode.role),
      "valueResult": .string(valueResult.name),
      "readBack": after.value.map { .string($0) } ?? .null,
    ])
    return await withOutcome(CLIReply(ok: matched, text: lines.joined(separator: "\n"), data: data, code: matched ? nil : .inputUnconfirmed), tab, since: acted, watch)
  }

  private func setChecked(_ tab: TabInfo, _ ref: PageRef, _ control: InspectResult, _ value: FormValue) async throws -> CLIReply {
    let kind = control.kind.rawValue
    let wanted: Bool

    switch value {
    case let .checked(flag): wanted = flag
    case .text("true"): wanted = true
    case .text("false"): wanted = false
    case let .text(other): throw Failure(.invalidArgument, "ref \(ref) is a \(kind), so value must be true or false, not \"\(other)\"")
    }

    let state = { (checked: Bool?) in checked == true ? "checked" : "unchecked" }
    var data: [String: JSONValue] = ["tabId": .number(Double(tab.id)), "ref": .string(ref.description), "kind": .string(kind), "checked": .bool(wanted)]

    if control.checked == wanted { return CLIReply(ok: true, text: "\(kind) ref \(ref) is already \(state(wanted)); nothing pressed", data: .object(data)) }

    if control.kind == .radio, !wanted { throw Failure(.invalidArgument, "radio ref \(ref) cannot be unchecked directly; check another radio in its group") }

    let located = try await locateHittable(tab.id, ref)
    let match = try await AXEngine.resolve(located, tab: tab)
    let watch = await watchChanges(tab.id, ref)
    let pressed = try await Timing.measure("press") { try AXEngine.press(match) }
    let acted = ContinuousClock.now
    let after = try await settled(tab.id, ref) { $0.checked == wanted }
    data["pressedRole"] = .string(pressed.role)

    guard after.checked == wanted else {
      data["checked"] = .bool(after.checked == true)
      let lines = ["pressed \(pressed.summary) but \(kind) ref \(ref) is still \(state(after.checked))"] + matchLines(located, match)
      return await withOutcome(CLIReply(failing: .inputUnconfirmed, text: lines.joined(separator: "\n"), data: .object(data)), tab, since: acted, watch)
    }

    return await withOutcome(CLIReply(ok: true, text: "\(state(wanted)) \(kind) ref \(ref) by pressing \(pressed.summary)", data: .object(data)), tab, since: acted, watch)
  }

  private func select(_ tab: TabInfo, _ ref: PageRef, _ control: InspectResult, _ value: FormValue, compat: Bool) async throws -> CLIReply {
    guard case let .text(wanted) = value else { throw Failure(.invalidArgument, "ref \(ref) is a select, so value must be an option's value or label") }

    let options = control.options ?? []
    let listed = options.map { "\"\($0.label)\"" }.joined(separator: ", ")

    guard let index = options.firstIndex(where: { $0.value == wanted }) ?? options.firstIndex(where: { $0.label == wanted }) else {
      throw Failure(.invalidArgument, "select ref \(ref) has no option whose value or label is \"\(wanted)\"; options: \(listed)")
    }

    let option = options[index]
    var data: [String: JSONValue] = ["tabId": .number(Double(tab.id)), "ref": .string(ref.description), "index": .number(Double(index)), "value": .string(option.value), "label": .string(option.label)]

    if control.selectedIndex == index { return CLIReply(ok: true, text: "select ref \(ref) already shows \"\(option.label)\"; nothing changed", data: .object(data)) }

    guard !option.disabled else { throw Failure(.notActionable, "option \"\(option.label)\" of select ref \(ref) is disabled") }

    if !compat {
      let watch = await watchChanges(tab.id, ref)
      let after = try await content(tab.id, .selectOption(ref: ref, index: index)).decode(InspectResult.self)
      let acted = ContinuousClock.now
      let picked = after.selectedIndex == index
      let text = picked ? "selected \"\(option.label)\" in select ref \(ref) from the page script; its input and change events are untrusted" : "set select ref \(ref) to \"\(option.label)\" from the page script but it shows option \(after.selectedIndex.map(String.init) ?? "none"); compat true picks it from Safari's menu"
      return await withOutcome(CLIReply(ok: picked, text: text, data: .object(data), code: picked ? nil : .inputUnconfirmed), tab, since: acted, watch)
    }

    let located = try await locateHittable(tab.id, ref)
    let match = try await AXEngine.resolve(located, tab: tab)
    let occurrence = options[..<index].filter { $0.label == option.label }.count
    let watch = await watchChanges(tab.id, ref)
    let item = try await AXEngine.pickOption(option.label, occurrence: occurrence, in: match)
    let acted = ContinuousClock.now
    let after = try await settled(tab.id, ref) { $0.selectedIndex == index }

    guard after.selectedIndex == index else {
      let shown = after.selectedIndex.flatMap { options.indices.contains($0) ? options[$0].label : nil } ?? "nothing"
      data["selectedIndex"] = after.selectedIndex.map { .number(Double($0)) } ?? .null
      let lines = ["pressed \(item.summary) in the open menu but select ref \(ref) still shows \"\(shown)\""] + matchLines(located, match)
      return await withOutcome(CLIReply(failing: .inputUnconfirmed, text: lines.joined(separator: "\n"), data: .object(data)), tab, since: acted, watch)
    }

    return await withOutcome(CLIReply(ok: true, text: "selected \"\(option.label)\" in select ref \(ref) by pressing \(item.summary) in its menu", data: .object(data)), tab, since: acted, watch)
  }

  /// Sets a color, date or time input from the page script, which needs no window made main: the AXColorWell ignores AXValue, and date and time fields take only real keys. Its input and change events are untrusted.
  private func setPageValue(_ tab: TabInfo, _ ref: PageRef, _ kind: ControlKind, _ value: String) async throws -> CLIReply {
    let watch = await watchChanges(tab.id, ref)
    let after = try await content(tab.id, .setValue(ref: ref, value: value)).decode(InspectResult.self)
    let acted = ContinuousClock.now
    let shown = after.value ?? ""
    let data: JSONValue = .object(["tabId": .number(Double(tab.id)), "ref": .string(ref.description), "kind": .string(kind.rawValue), "readBack": .string(shown)])

    if kind == .color {
      let lines = [
        "set color ref \(ref) from the page script; its input and change events are untrusted",
        "read back: \"\(shown)\" \(shown.lowercased() == value.lowercased() ? "(matches)" : "(the input's serialization)")",
      ]
      return await withOutcome(CLIReply(ok: true, text: lines.joined(separator: "\n"), data: data), tab, since: acted, watch)
    }

    let matched = Self.trimmedTime(shown) == Self.trimmedTime(value)
    let lines = [
      "set \(kind.rawValue) ref \(ref) from the page script; its input and change events are untrusted",
      "read back: \"\(shown)\" \(matched ? "(matches)" : "(DIFFERS)")",
    ]
    return await withOutcome(CLIReply(ok: matched, text: lines.joined(separator: "\n"), data: data, code: matched ? nil : .inputUnconfirmed), tab, since: acted, watch)
  }

  /// A zero seconds or milliseconds part may or may not appear in a time value, so both sides drop it before comparing.
  static func trimmedTime(_ text: String?) -> String { (text ?? "").replacing(/(:\d{2})\.0+$/) { $0.1 }.replacing(/(\d{2}:\d{2}):00$/) { $0.1 } }

  /// An ARIA slider ignores AXValue, so real keys move every slider: Home or End reach a known end, one arrow press measures the step and which arrow raises the value,
  /// then the presses that remain go in one run and up to two more correct a page that skipped some or moved on its own, unless a run barely moved the value, which reads as stale.
  /// A value between steps ends on the nearest step.
  private func setSlider(_ tab: TabInfo, _ ref: PageRef, _ control: InspectResult, _ wanted: Double, compat: Bool) async throws -> CLIReply {
    let shown = { (number: Double) in number.formatted(.number.grouping(.never)) }
    let number = { (control: InspectResult) in control.value.flatMap(Double.init) }

    guard var current = number(control) else { throw Failure(.notActionable, "slider ref \(ref) shows no numeric value (aria-valuenow), so where it lands cannot be read back") }

    if let min = control.min, wanted < min { throw Failure(.invalidArgument, "slider ref \(ref) goes down to \(shown(min)), so it cannot be set to \(shown(wanted))") }

    if let max = control.max, wanted > max { throw Failure(.invalidArgument, "slider ref \(ref) goes up to \(shown(max)), so it cannot be set to \(shown(wanted))") }

    var data: [String: JSONValue] = ["tabId": .number(Double(tab.id)), "ref": .string(ref.description), "kind": .string("slider")]

    if current == wanted { return CLIReply(ok: true, text: "slider ref \(ref) is already at \(shown(wanted)); nothing pressed", data: .object(data)) }

    let start = current
    let watch = await watchChanges(tab.id, ref)
    var pressed: [String] = []
    var acted = ContinuousClock.now

    func press(_ name: String, _ times: Int, until done: @escaping (Double) -> Bool) async throws {
      let reply = try await key(tab.id, [KeyChord.parse(name)], ref, times, compat: compat, showChanges: false)

      guard reply.ok else { throw Failure(reply.code ?? .inputUnconfirmed, "pressing \(name) on slider ref \(ref) failed: \(reply.text)") }

      acted = ContinuousClock.now
      pressed.append(times > 1 ? "\(name) x\(times)" : name)
      var after = try await inspect(tab.id, ref)
      let prompt = number(after).map(done) ?? false

      for _ in 0 ..< 20 where !(number(after).map(done) ?? false) {
        try await Timing.sleep(for: .milliseconds(100))
        after = try await inspect(tab.id, ref)
      }

      guard var value = number(after) else { throw Failure(.notActionable, "slider ref \(ref) stopped showing a numeric value after \(name)") }

      // A page may apply presses late (YouTube batches seeks for about half a second), so a value that was not there at once counts only after it holds for 300 ms.
      for _ in 0 ..< 5 where !prompt {
        try await Timing.sleep(for: .milliseconds(300))

        guard let next = number(try await inspect(tab.id, ref)) else { throw Failure(.notActionable, "slider ref \(ref) stopped showing a numeric value after \(name)") }

        if next == value { break }

        value = next
      }

      current = value
    }

    if wanted == control.min || wanted == control.max { try await press(wanted == control.min ? "Home" : "End", 1) { $0 == wanted } }

    var step = 0.0
    var stale: (moved: Double, presses: Int)?

    if current != wanted {
      let before = current
      let first = wanted > current ? "ArrowRight" : "ArrowLeft"
      let other = wanted > current ? "ArrowLeft" : "ArrowRight"
      try await press(first, 1) { $0 != before }
      step = current - before

      guard step != 0 else { throw Failure(.notActionable, "slider ref \(ref) stayed at \(shown(before)) after \(first), so it does not take arrow keys; use click or key") }

      let raise = step > 0 ? first : other
      let lower = step > 0 ? other : first

      for _ in 0 ..< 3 where abs(wanted - current) > abs(step) / 2 {
        let count = Int((abs(wanted - current) / abs(step)).rounded())

        guard count <= 500 else { throw Failure(.invalidArgument, "slider ref \(ref) moves \(shown(abs(step))) per arrow press, so \(shown(wanted)) is \(count) presses away; pick a value within 500 steps") }

        let from = current
        let expected = current + Double(count) * abs(step) * (wanted > current ? 1 : -1)
        try await press(wanted > current ? raise : lower, count) { abs($0 - expected) < abs(step) / 2 }

        // A page in a background window may not redraw where its slider went (YouTube updates aria-valuenow on animation frames, which stall there),
        // so a run that barely moved the value stops here rather than pressing on from a stale read and overshooting.
        if count > 1, abs(current - from) < Double(count) * abs(step) / 2 {
          stale = (abs(current - from), count)
          break
        }
      }
    }

    let matched = current == wanted || abs(wanted - current) <= abs(step) / 2
    let note = current == wanted ? "(matches)" : matched ? "(nearest step of \(shown(abs(step))))" : "(DIFFERS)"
    data["readBack"] = .number(current)
    data["pressed"] = .array(pressed.map { .string($0) })
    let lines = ["moved slider ref \(ref) from \(shown(start)) by pressing \(pressed.joined(separator: ", "))", "read back: \(shown(current)) \(note)"]
      + (stale.map { ["the slider moved \(shown($0.moved)) for \($0.presses) presses of \(shown(abs(step))), so the page may not be showing where it went (a page in a background window can redraw late); check what the slider controls before pressing more"] } ?? [])
    return await withOutcome(CLIReply(ok: matched, text: lines.joined(separator: "\n"), data: .object(data), code: matched ? nil : .inputUnconfirmed), tab, since: acted, watch)
  }

  /// compat: WebKit draws these inputs as separate AXIncrementor fields whose AXValue does not stick, so each field is focused and its digits typed as real keys; change fires when focus leaves, as after a person types.
  private func setDateTime(_ tab: TabInfo, _ ref: PageRef, _ kind: ControlKind, _ value: String, _ parts: [String: String]) async throws -> CLIReply {
    let located = try await locateHittable(tab.id, ref, coveredOK: true)
    let match = try await AXEngine.resolve(located, tab: tab)
    let fields = try AXEngine.dateTimeFields(in: match)
    let titles = fields.map { $0.string(kAXTitleAttribute) ?? "" }
    // The meridiem field is the one without a title.
    let twelveHour = titles.contains("")
    var pid: pid_t = 0
    AXUIElementGetPid(match.target.app.element, &pid)
    var poster = EventPoster(pid: pid, windowID: nil)
    var typed: [String] = []
    let watch = await watchChanges(tab.id, ref)
    let hour = Int(parts["hour"] ?? "0") ?? 0

    for (field, title) in zip(fields, titles) {
      let text: String

      switch title {
      case "": text = hour < 12 ? "A" : "P"
      case "hour": text = String(format: "%02d", twelveHour ? (hour % 12 == 0 ? 12 : hour % 12) : hour)
      case "seconds": text = parts[title] ?? "00"
      case "milliseconds": text = parts[title] ?? "000"
      default:
        guard let part = parts[title] else { throw Failure(.notActionable, "ref \(ref) shows a field titled \"\(title)\" that \"\(value)\" has no part for; fields: \(titles.map { "\"\($0)\"" }.joined(separator: ", "))") }

        text = part
      }

      let focused = AXUIElementSetAttributeValue(field.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)

      guard focused == .success else { throw Failure(.notActionable, "AXFocused=true on \(field.summary) failed: \(focused.name)") }

      try await awaitFocus(field, in: match.target)

      for character in text {
        try await poster.key(KeyChord.typing(character))
        try await Task.sleep(for: .milliseconds(10))
      }

      typed.append("\(title.isEmpty ? "meridiem" : title) \(text)")
    }

    let acted = ContinuousClock.now

    let after = try await settled(tab.id, ref) { Self.trimmedTime($0.value) == Self.trimmedTime(value) }
    let matched = Self.trimmedTime(after.value) == Self.trimmedTime(value)
    let lines = [
      "typed \(typed.joined(separator: ", ")) into \(kind.rawValue) ref \(ref)",
      "read back: \"\(after.value ?? "")\" \(matched ? "(matches)" : "(DIFFERS)")",
    ] + matchLines(located, match)
    let data: JSONValue = .object(["tabId": .number(Double(tab.id)), "ref": .string(ref.description), "kind": .string(kind.rawValue), "readBack": .string(after.value ?? "")])
    return await withOutcome(CLIReply(ok: matched, text: lines.joined(separator: "\n"), data: data, code: matched ? nil : .inputUnconfirmed), tab, since: acted, watch)
  }

  /// Splits an input value (YYYY-MM-DD, HH:MM[:SS[.mmm]], or both joined by T) into parts keyed by WebKit's field titles, hour in 24 h.
  private func dateTimeParts(_ kind: ControlKind, _ value: String, _ ref: PageRef) throws -> [String: String] {
    let formats: [ControlKind: String] = [.date: "YYYY-MM-DD", .time: "HH:MM or HH:MM:SS", .dateTimeLocal: "YYYY-MM-DDTHH:MM"]
    let bad = Failure(.invalidArgument, "ref \(ref) is a \(kind.rawValue) input, so value must look like \(formats[kind] ?? "?"), not \"\(value)\"")
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

    throw Failure(.notActionable, "set AXFocused on \(field.summary) but Safari reports focus on \(focused()?.summary ?? "nothing") in \(isMain() ? "the main window" : "a window that is not main"); no keys were posted to it")
  }
}
