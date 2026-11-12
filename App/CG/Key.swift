import ApplicationServices
import Foundation

/// key: posts pid-targeted key presses at a tab's focused element without activating Safari, then counts the keydowns the page logged.
extension Commands {
  func key(_ tabId: Int?, _ chords: [KeyChord], _ ref: Int?, _ times: Int) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let target: AXEngine.Target
    let focusNode: AXNode

    if let ref {
      let located = try await locateHittable(tab.id, ref, coveredOK: true)
      let match = try await AXEngine.resolve(located, tab: tab)
      let (focused, result) = try AXEngine.focus(match)

      guard result == .success else { throw Failure(description: "AXFocused=true on \(focused.summary) for ref \(ref) failed: \(result.name)") }

      target = match.target
      focusNode = focused
    } else {
      target = try await AXEngine.target(for: tab)
      focusNode = target.webArea
    }

    try await requireKeyboardFocus(in: target, refocus: focusNode)
    var pid: pid_t = 0
    AXUIElementGetPid(target.app.element, &pid)
    let origin = try await content(tab.id, .events(clear: true, arm: false)).decode(EventsResult.self).origin
    var poster = EventPoster(pid: pid, windowID: nil)
    let presses = Array(repeating: chords, count: times).joined()

    for (index, chord) in presses.enumerated() {
      if index > 0 { try await Task.sleep(for: .milliseconds(10)) }

      try await poster.key(chord)
    }

    let pressed = chords.map(\.name).joined(separator: " ") + (times > 1 ? " x\(times)" : "")
    let expected = times * chords.reduce(0) { $0 + $1.modifiers.count + 1 }
    var data: [String: JSONValue] = [
      "tabId": .number(Double(tab.id)),
      "chords": .array(chords.map { .string($0.name) }),
      "repeat": .number(Double(times)),
      "expected": .number(Double(expected)),
    ]
    var keydowns: [LoggedEvent] = []
    // WebKit hands the page each key only after it handled the last one, so a page busy rendering (an autocomplete) is still receiving keys well after they were posted.
    let deadline = ContinuousClock.now + .milliseconds(1500)
    try await Task.sleep(for: .milliseconds(150))

    while true {
      var after: JSONValue?
      var readError = ""

      do { after = try await content(tab.id, .events(clear: true, arm: false)) } catch { readError = " (reading the log failed: \(error))" }

      guard let after, after["origin"]?.number == origin else {
        data["navigated"] = .bool(true)
        data["delivered"] = .null
        return CLIReply(ok: true, text: "pressed \(pressed) in tab \(tab.id); the page navigated or reloaded, so delivery could not be counted\(readError)", data: .object(data))
      }

      keydowns += try after.decode(EventsResult.self).events.filter { $0.type == "keydown" && $0.isTrusted }

      if keydowns.count >= expected || ContinuousClock.now >= deadline { break }

      try await Task.sleep(for: .milliseconds(100))
    }

    data["navigated"] = .bool(false)
    data["delivered"] = .number(Double(keydowns.count))
    data["keydowns"] = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(keydowns))
    let logged = keydowns.map { "  \(describe($0))" }

    if keydowns.count < expected {
      let lines = [
        "pressed \(pressed) in tab \(tab.id); only \(keydowns.count) of \(expected) keydowns reached the page within 1.5 s, so Safari or something outside the top frame (iframes are not logged) took the rest",
        "post access (CGPreflightPostEventAccess): \(CGPreflightPostEventAccess())",
        "logged keydowns:",
      ] + (logged.isEmpty ? ["  none"] : logged)
      return CLIReply(ok: false, text: lines.joined(separator: "\n"), data: .object(data))
    }

    let extra = keydowns.count > expected ? ", more than posted, so other key input reached the page too" : ""
    let last = keydowns.last.map { event in "\(event.ref.map { "[\($0)] " } ?? "")\(event.target)" } ?? "?"
    return CLIReply(ok: true, text: "pressed \(pressed) in tab \(tab.id); \(keydowns.count) of \(expected) keydowns reached the page\(extra), last on \(last)", data: .object(data))
  }

  /// Key events go to whatever Safari has focused, so refuse unless that is the tab's web area or inside it; untested live.
  private func requireKeyboardFocus(in target: AXEngine.Target, refocus: AXNode) async throws {
    let focused = { target.app.value(kAXFocusedUIElementAttribute).map { AXNode(element: $0 as! AXUIElement) } }

    if focused()?.chain(upTo: target.webArea) != nil { return }

    var steps: [String] = []
    let isMain = { target.window.value(kAXMainAttribute) as? Bool == true }

    if !isMain() {
      steps.append("AXMain on \(target.window.summary): \(AXUIElementSetAttributeValue(target.window.element, kAXMainAttribute as CFString, kCFBooleanTrue).name)")
    }

    // A window Safari opened unfocused while in the background never reports a focused element, yet keys posted to Safari reach its page, and refocusing the web area would blur the page's focused field; the keydown count afterwards catches keys that went nowhere.
    if focused() == nil, isMain() { return }

    steps.append("AXFocused on \(refocus.summary): \(AXUIElementSetAttributeValue(refocus.element, kAXFocusedAttribute as CFString, kCFBooleanTrue).name)")

    // Safari reports no focused element for a moment after focus first moves into a page, so poll before giving up.
    for _ in 0 ..< 20 {
      if focused()?.chain(upTo: target.webArea) != nil { return }

      try await Task.sleep(for: .milliseconds(50))
    }

    let ancestry = focused().map { sequence(first: $0, next: \.parent).prefix(6).map(\.summary).joined(separator: " < ") } ?? "nothing (Safari reports no focused element)"
    throw Failure(description: "keyboard focus is outside the tab's page, on \(ancestry), after setting \(steps.joined(separator: ", ")); no keys were posted")
  }
}
