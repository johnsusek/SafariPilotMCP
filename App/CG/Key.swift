import ApplicationServices
import Foundation

/// key: posts pid-targeted key presses at a tab's focused element without activating Safari, then counts the keydowns the page logged.
extension Commands {
  func key(_ tabId: Int?, _ chords: [KeyChord], _ ref: PageRef?, _ times: Int) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let target: AXEngine.Target
    let focusNode: AXNode

    if let ref {
      let located = try await locateHittable(tab.id, ref, coveredOK: true)
      try refuseSandboxed(located, "a key press")
      let match = try await AXEngine.resolve(located, tab: tab)
      _ = try await content(tab.id, .focus(ref: ref))
      target = match.target
      focusNode = match.chain.first { $0.isSettable(kAXFocusedAttribute) } ?? target.webArea
    } else {
      target = try await AXEngine.target(for: tab)
      focusNode = target.webArea
    }

    try await requireKeyboardFocus(in: target, refocus: focusNode)
    var pid: pid_t = 0
    AXUIElementGetPid(target.app.element, &pid)
    let before = try await content(tab.id, .events(clear: true, arm: false, watch: ref)).decode(EventsResult.self)

    if let ref { try before.requireAnswered(ref.frame, so: "keys for ref \(ref) could not be counted; nothing was pressed") }

    var poster = EventPoster(pid: pid, windowID: nil)
    let presses = Array(repeating: chords, count: times).joined()

    for (index, chord) in presses.enumerated() {
      if index > 0 {
        try await Task.sleep(for: .milliseconds(10))
        try await requireFocusKept(in: target, posted: index, of: chords.count * times)
      }

      try await poster.key(chord)
    }

    let pressed = KeyChord.summary(chords) + (times > 1 ? " x\(times)" : "")
    let expected = times * chords.reduce(0) { $0 + $1.modifiers.count + 1 }
    var data: [String: JSONValue] = [
      "tabId": .number(Double(tab.id)),
      "chords": .array(chords.map { .string($0.name) }),
      "repeat": .number(Double(times)),
      "expected": .number(Double(expected)),
    ]
    var keydowns: [LoggedEvent] = []
    // Keys land in whichever frame has focus, and Tab can move focus between frames, so keydowns are summed over every frame read both before and after.
    // The top frame or the ref's own frame navigating voids the count at once; any other frame navigating (Enter submitting a form in it) voids it only when keydowns are missing, since that frame's log went with its document.
    let watched = ref.map { ["", $0.frame] } ?? [""]
    var replaced: Set<String> = []
    var busy: [String] = []
    var navigatedWhat: String?
    var readError = ""
    let acted = ContinuousClock.now
    // WebKit hands the page each key only after it handled the last one, so a page busy rendering (an autocomplete) is still receiving keys well after they were posted.
    let deadline = ContinuousClock.now + .milliseconds(1500)
    try await Task.sleep(for: .milliseconds(150))

    // A dialog stops Safari's extension until it closes, so the page's log cannot be read; the dialog shows the keys arrived.
    if let open = try AXEngine.dialog(for: tab) {
      data["dialog"] = try JSONValue(encoding: open.dialog)
      return CLIReply(ok: true, text: "pressed \(pressed) in tab \(tab.id), which opened \(open.dialog.line); handle_dialog accepts or dismisses it", data: .object(data))
    }

    while true {
      var after: JSONValue?

      do { after = try await content(tab.id, .events(clear: true, arm: false, watch: ref)) } catch { readError = " (reading the log failed: \(error))" }

      guard let events = try after?.decode(EventsResult.self) else {
        navigatedWhat = "the page"
        break
      }

      if let frame = watched.first(where: { events.replaced($0, since: before) }) {
        navigatedWhat = frame.isEmpty ? "the page" : "the frame of iframe \(frame)"
        break
      }

      replaced.formUnion(before.origins.keys.filter { events.replaced($0, since: before) })
      busy = events.busy
      keydowns += events.events.filter { $0.type == "keydown" && $0.isTrusted && events.origins[$0.frame] == before.origins[$0.frame] }

      if keydowns.count >= expected || ContinuousClock.now >= deadline { break }

      try await Task.sleep(for: .milliseconds(100))
    }

    let landed = await landing(tab, since: acted, replaced: navigatedWhat == "the page")

    if navigatedWhat == nil, keydowns.count < expected { navigatedWhat = landed.moved ? "the page" : replaced.sorted().first.map { "the frame of iframe \($0)" } }

    if let what = navigatedWhat {
      data["navigated"] = .bool(true)
      data["delivered"] = .null
      let text = "pressed \(pressed) in tab \(tab.id); \(what) navigated or reloaded, so delivery could not be counted\(readError)"
      return CLIReply(ok: true, text: ([text] + landed.lines).joined(separator: "\n"), data: .object(data))
    }

    data["navigated"] = .bool(false)
    data["delivered"] = .number(Double(keydowns.count))
    data["keydowns"] = try JSONValue(encoding: keydowns)
    let logged = keydowns.map { "  \(describe($0))" }

    if keydowns.count < expected {
      let lines = [
        "pressed \(pressed) in tab \(tab.id); only \(keydowns.count) of \(expected) keydowns reached the page within 1.5 s, so Safari, or a frame SafariPilot cannot read, took the rest\(busy.isEmpty ? "" : " (frames still busy: \(busy.joined(separator: ", ")))")",
        "post access (CGPreflightPostEventAccess): \(CGPreflightPostEventAccess())",
        "logged keydowns:",
      ] + (logged.isEmpty ? ["  none"] : logged) + landed.lines
      return CLIReply(failing: .inputUnconfirmed, text: lines.joined(separator: "\n"), data: .object(data))
    }

    let extra = keydowns.count > expected ? ", more than posted, so other key input reached the page too" : ""
    let last = keydowns.last.map { event in "\(event.ref.map { "[\($0)] " } ?? "")\(event.target)" } ?? "?"
    let text = "pressed \(pressed) in tab \(tab.id); \(keydowns.count) of \(expected) keydowns reached the page\(extra), last on \(last)"
    return CLIReply(ok: true, text: ([text] + landed.lines).joined(separator: "\n"), data: .object(data))
  }

  private func focused(in target: AXEngine.Target) -> AXNode? {
    target.app.value(kAXFocusedUIElementAttribute).map { AXNode(element: $0 as! AXUIElement) }
  }

  /// Whether node is the tab's web area, inside it, or inside one of its frames.
  private func inPage(_ node: AXNode?, of target: AXEngine.Target) -> Bool {
    guard let node else { return false }

    if node.chain(upTo: target.webArea) != nil { return true }

    let window = node.value(kAXWindowAttribute).map { CFEqual($0, target.window.element) } ?? false
    let ancestors = sequence(first: node, next: \.parent).prefix(64).map { (role: $0.role, frame: $0.frame) }
    return KeyboardFocus.inFrameOfPage(sameWindow: window, ancestors: ancestors, webArea: target.webArea.frame)
  }

  private func isMain(_ target: AXEngine.Target) -> Bool { target.window.value(kAXMainAttribute) as? Bool == true }

  private func focusAncestry(in target: AXEngine.Target) -> String {
    focused(in: target).map { sequence(first: $0, next: \.parent).prefix(6).map(\.summary).joined(separator: " < ") } ?? "nothing (Safari reports no focused element)"
  }

  /// Each key goes to whatever Safari has focused when it is posted, so a sequence stops once that is no longer the tab's page: the person clicked another Safari window
  /// or the address bar, or the page navigated. No focus at all in the tab's main window still reaches the page, as for a window opened unfocused in the background.
  /// Safari reports focus late while it moves, so it is read again for up to 250 ms before giving up.
  private func requireFocusKept(in target: AXEngine.Target, posted: Int, of total: Int) async throws {
    for _ in 0 ..< 5 {
      let node = focused(in: target)

      if node == nil, isMain(target) { return }

      if inPage(node, of: target) { return }

      try await Task.sleep(for: .milliseconds(50))
    }

    throw Failure(.inputUnconfirmed, "posted \(posted) of \(total) key presses, then stopped: Safari's keyboard focus left the tab's page for \(focusAncestry(in: target)), so the rest were not sent")
  }

  /// Key events go to whatever Safari has focused, so refuse unless that is the tab's web area, inside it, or inside one of its frames.
  private func requireKeyboardFocus(in target: AXEngine.Target, refocus: AXNode) async throws {
    if inPage(focused(in: target), of: target) { return }

    var steps: [String] = []

    if !isMain(target) {
      steps.append("AXMain on \(target.window.summary): \(AXUIElementSetAttributeValue(target.window.element, kAXMainAttribute as CFString, kCFBooleanTrue).name)")
    }

    // A window Safari opened unfocused while in the background never reports a focused element, yet keys posted to Safari reach its page, and refocusing the web area would blur the page's focused field; the keydown count afterwards catches keys that went nowhere.
    if focused(in: target) == nil, isMain(target) { return }

    steps.append("AXFocused on \(refocus.summary): \(AXUIElementSetAttributeValue(refocus.element, kAXFocusedAttribute as CFString, kCFBooleanTrue).name)")

    // Safari reports no focused element for a moment after focus first moves into a page, so poll before giving up.
    for _ in 0 ..< 20 {
      if inPage(focused(in: target), of: target) { return }

      try await Task.sleep(for: .milliseconds(50))
    }

    throw Failure(.notActionable, "keyboard focus is outside the tab's page, on \(focusAncestry(in: target)), after setting \(steps.joined(separator: ", ")); no keys were posted")
  }
}
