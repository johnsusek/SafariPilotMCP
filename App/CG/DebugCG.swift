import AppKit
import ApplicationServices

/// debug-cg: posts Quartz input at page elements without activating Safari, then reports what the page logged.
extension Commands {
  func debugCG(_ tabId: Int?, _ probe: CGProbe, _ windowFields: Bool) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    var setup: [String] = []
    var matches: [AXEngine.Match] = []
    var scroll: (Double, Double)?

    for ref in probe.refs {
      let located = try await locateHittable(tab.id, ref)
      let position = (located.viewport.scrollX, located.viewport.scrollY)

      // Locate centers each element, so a second ref that scrolls the page has moved the first one.
      if let scroll, scroll != position { throw Failure(description: "locating ref \(ref) scrolled the page; FROM and TO must be visible together") }

      scroll = position
      let match = try await AXEngine.resolve(located, tab: tab)
      setup += ["ref \(ref):"] + matchLines(located, match).map { "  \($0)" }
      matches.append(match)
    }

    let target: AXEngine.Target

    if let match = matches.first { target = match.target } else { target = try await AXEngine.target(for: tab) }

    var pid: pid_t = 0
    AXUIElementGetPid(target.app.element, &pid)

    if case let .key(_, ref?) = probe {
      let (focused, result) = try AXEngine.focus(matches[0])
      setup.append("AXFocused=true on \(focused.summary) for ref \(ref): \(result.name)")
    }

    var windowID: CGWindowID?

    if !probe.isKey, windowFields {
      guard let frame = target.window.frame else { throw Failure(description: "target window \(target.window.summary) has no AX frame") }

      windowID = try EventPoster.windowID(pid: pid, frame: frame)
    }

    let frontBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    let main = target.window.value(kAXMainAttribute) as? Bool
    let focused = target.window.value(kAXFocusedAttribute) as? Bool
    let postAccess = CGPreflightPostEventAccess()
    let points = matches.map(\.screenPoint)

    _ = try await content(tab.id, .events(clear: true, arm: true))
    var poster = EventPoster(pid: pid, windowID: windowID)

    switch probe {
    case let .key(chord, _): try await poster.key(chord)
    case .click: try await poster.click(at: points[0])
    case .hover: try await poster.hover(to: points[0])
    case .drag: try await poster.drag(from: points[0], to: points[1])
    }

    try await Task.sleep(for: .milliseconds(300))

    var hover: Bool?
    var value: String?

    if case let .hover(ref) = probe { hover = try await content(tab.id, .inspect(ref: ref)).decode(InspectResult.self).hover }

    if case let .key(_, ref?) = probe { value = try await content(tab.id, .inspect(ref: ref)).decode(InspectResult.self).value }

    let frontAfter = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    let eventsResponse = try await content(tab.id, .events(clear: true, arm: false))
    let events = try eventsResponse.decode(EventsResult.self).events
    let trusted = Set(events.filter(\.isTrusted).map(\.type))
    let untrusted = Set(events.filter { !$0.isTrusted }.map(\.type))
    let expected = probe.expectedTypes
    let arrivedTrusted = expected.filter { trusted.contains($0) }
    let arrivedUntrustedOnly = expected.filter { !trusted.contains($0) && untrusted.contains($0) }
    let missing = expected.filter { !trusted.contains($0) && !untrusted.contains($0) }
    let others = Array(trusted.union(untrusted).subtracting(expected)).sorted()
    let list = { (types: [String]) in types.isEmpty ? "none" : types.joined(separator: ", ") }
    let summary = events.isEmpty
      ? "nothing arrived: the page logged no events"
      : "expected trusted: \(list(arrivedTrusted)); untrusted only: \(list(arrivedUntrustedOnly)); missing: \(list(missing)); also: \(list(others))"

    var lines = [
      "pid \(pid)\(windowID.map { ", window fields \($0)" } ?? "")",
      "post access (CGPreflightPostEventAccess): \(postAccess)",
      "Safari frontmost: before \(frontBefore), after \(frontAfter); target window main \(main.map(String.init) ?? "?") focused \(focused.map(String.init) ?? "?")",
      "points: \(points.isEmpty ? "none" : points.map(AXEngine.format).joined(separator: " to "))",
    ] + setup + ["posted:"] + poster.posted.map { "  \($0)" } + ["page events:"] + (events.isEmpty ? ["  none"] : events.map { "  \(describe($0))" })

    if let hover { lines.append("target matches :hover: \(hover)") }

    if case .key(_, _?) = probe { lines.append("field value: \(value.map { "\"\($0)\"" } ?? "none (not a form field or contenteditable)")") }

    lines.append("summary: \(summary)")
    let strings = { (types: [String]) in JSONValue.array(types.map { .string($0) }) }
    let data: JSONValue = .object([
      "tabId": .number(Double(tab.id)),
      "pid": .number(Double(pid)),
      "windowId": windowID.map { .number(Double($0)) } ?? .null,
      "postAccess": .bool(postAccess),
      "safariFrontmostBefore": .bool(frontBefore),
      "safariFrontmostAfter": .bool(frontAfter),
      "windowMain": main.map { .bool($0) } ?? .null,
      "windowFocused": focused.map { .bool($0) } ?? .null,
      "points": .array(points.map { .array([.number($0.x), .number($0.y)]) }),
      "posted": strings(poster.posted),
      "events": eventsResponse["events"] ?? .null,
      "expectedTrusted": strings(arrivedTrusted),
      "expectedUntrustedOnly": strings(arrivedUntrustedOnly),
      "missing": strings(missing),
      "other": strings(others),
      "hover": hover.map { .bool($0) } ?? .null,
      "value": value.map { .string($0) } ?? .null,
      "summary": .string(summary),
    ])
    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: data)
  }
}

extension CGProbe {
  var refs: [PageRef] {
    switch self {
    case let .key(_, ref): ref.map { [$0] } ?? []
    case let .click(ref), let .hover(ref): [ref]
    case let .drag(from, to): [from, to]
    }
  }

  var expectedTypes: [String] {
    switch self {
    case .key: ["keydown", "keyup"]
    case .click: ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]
    case .hover: ["pointermove", "mousemove", "pointerover", "mouseover", "pointerenter", "mouseenter"]
    case .drag: ["pointerdown", "mousedown", "pointermove", "mousemove", "dragstart", "dragover", "drop", "dragend"]
    }
  }
}
