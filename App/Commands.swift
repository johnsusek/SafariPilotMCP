import ApplicationServices
import Foundation

/// Runs one app command against the background and AX, and renders it as text plus data.
@MainActor
struct Commands {
  let model: AppModel
  let deadline: ContinuousClock.Instant

  func run(_ command: AppCommand) async throws -> CLIReply {
    switch command {
    case .status: status()
    case let .ping(tabId): try await ping(tabId)
    case let .snapshot(tabId): try await snapshot(tabId)
    case let .click(tabId, ref): try await click(tabId, ref)
    case let .type(tabId, ref, text): try await type(tabId, ref, text)
    case let .events(tabId, clear): try await events(tabId, clear)
    case .tabs: try await tabs()
    case let .tabCreate(url): try await tabReply("opened", call(.tabCreate(url: url)))
    case let .tabSelect(tabId): try await tabReply("selected", call(.tabSelect(tabId: tabId)))
    case let .tabClose(tabId): try await tabClose(tabId)
    case let .navigate(tabId, url): try await tabReply("loaded", call(.navigate(tabId: tabId, url: url)))
    case let .history(tabId, direction): try await tabReply("went \(direction.rawValue) to", call(.history(tabId: tabId, direction: direction)))
    case let .readPage(tabId, filter, maxChars): try await readPage(tabId, filter, maxChars)
    case let .find(tabId, query): try await find(tabId, query)
    case let .pageText(tabId, maxChars): try await pageText(tabId, maxChars)
    case let .scroll(tabId, ref, left, top): try await scroll(tabId, ref, left, top)
    case let .key(tabId, chords, ref, times): try await key(tabId, chords, ref, times)
    case let .screenshot(tabId): try await screenshot(tabId)
    case let .debugAX(tabId, ref): try await debugAX(tabId, ref)
    case let .debugCG(tabId, probe, windowFields): try await debugCG(tabId, probe, windowFields)
    }
  }

  private func call(_ command: BackgroundCommand) async throws -> JSONValue {
    let remaining = deadline - .now

    guard remaining > .zero else { throw Failure(description: "timed out before sending \(command.type)") }

    let response = try await model.transport.send(command.json, timeout: remaining)

    if response["ok"]?.bool != true { throw Failure(description: "extension (\(command.type)): \(response["error"]?.string ?? "malformed response \(response)")") }

    return response
  }

  func content(_ tabId: Int?, _ request: ContentRequest) async throws -> JSONValue {
    try await call(.content(tabId: tabId, request: request))
  }

  /// Resolves the tab and makes it the active tab of its window, since AX and captureVisibleTab only see a window's visible tab.
  func frontTab(_ tabId: Int?) async throws -> TabInfo {
    let tab = try await call(.tab(tabId: tabId)).decode(TabResult.self).tab

    if tab.active { return tab }

    return try await call(.tabSelect(tabId: tab.id)).decode(TabResult.self).tab
  }

  private func describe(_ tab: TabInfo) -> String { "\(tab.active ? "*" : " ") \(tab.id) w\(tab.windowId) \(tab.url) \(tab.title)" }

  func describe(_ event: LoggedEvent) -> String {
    let count = event.count > 1 ? " x\(event.count)" : ""
    return "\(event.type) \(event.isTrusted ? "trusted" : "UNTRUSTED") \(event.ref.map { "[\($0)]" } ?? "")\(event.target) \(event.detail)\(count)"
  }

  private func describe(_ element: ElementInfo) -> String {
    let offscreen = element.inViewport ? "" : " (offscreen)"
    let disabled = element.disabled == true ? " (disabled)" : ""
    return "[\(element.ref)] \(element.role) \"\(element.name)\" <\(element.tag)>\(offscreen)\(disabled)"
  }

  private func status() -> CLIReply {
    let transport = model.transport
    let now = Date.now
    let ago = { (date: Date?) in date.map { "\(Int(now.timeIntervalSince($0)))s ago" } ?? "never" }
    let reachable = transport.openPollCount > 0
    var lines = [
      "accessibility: \(model.axTrusted ? "granted" : "not granted")",
      "extension: \(model.extensionState)",
      "listener: \(transport.listening ? "127.0.0.1:\(Wire.port)" : "down \(transport.listenError ?? "")")",
      "background: \(reachable ? "reachable (poll open \(ago(transport.oldestOpenPoll)))" : "not reachable") last seen \(ago(transport.lastSeen))",
      "dispatchMessage: \(transport.lastDispatch ?? "not used")",
      "instances:",
    ]
    let instances = transport.instances.values.sorted { $0.firstSeen < $1.firstSeen }

    for instance in instances.suffix(5) {
      lines.append("  \(instance.id.prefix(8)) started \(ago(instance.startedAt)) last seen \(ago(instance.lastSeen)) polls \(instance.polls)")
    }

    lines.append("lifecycle:")

    for entry in transport.lifecycle.suffix(15) {
      lines.append("  \(entry.at.formatted(date: .omitted, time: .standard)) \(entry.instance) \(entry.event)")
    }

    let data: JSONValue = .object([
      "accessibility": .bool(model.axTrusted),
      "extension": .string(model.extensionState),
      "listening": .bool(transport.listening),
      "reachable": .bool(reachable),
      "lastSeen": transport.lastSeen.map { .number($0.timeIntervalSince1970) } ?? .null,
      "instances": .array(instances.map { .object(["id": .string($0.id), "startedAt": .number($0.startedAt.timeIntervalSince1970), "lastSeen": .number($0.lastSeen.timeIntervalSince1970), "polls": .number(Double($0.polls))]) }),
      "lifecycle": .array(transport.lifecycle.suffix(50).map { .object(["instance": .string($0.instance), "event": .string($0.event), "at": .number($0.at.timeIntervalSince1970)]) }),
    ])
    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: data)
  }

  private func ping(_ tabId: Int?) async throws -> CLIReply {
    let response = try await content(tabId, .ping)
    let result = try response.decode(PingResult.self)
    return CLIReply(ok: true, text: "\(result.title)\n\(result.url)", data: response)
  }

  private func snapshot(_ tabId: Int?) async throws -> CLIReply {
    let response = try await content(tabId, .snapshot)
    let result = try response.decode(SnapshotResult.self)
    let lines = ["\(result.title) | \(result.url)"] + result.elements.map(describe)
    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: response)
  }

  private func events(_ tabId: Int?, _ clear: Bool) async throws -> CLIReply {
    let response = try await content(tabId, .events(clear: clear, arm: false))
    let lines = try response.decode(EventsResult.self).events.map(describe)
    return CLIReply(ok: true, text: lines.isEmpty ? "no events" : lines.joined(separator: "\n"), data: response)
  }

  private func tabs() async throws -> CLIReply {
    let response = try await call(.tabs)
    let lines = try response.decode(TabsResult.self).tabs.map(describe)
    return CLIReply(ok: true, text: lines.isEmpty ? "no tabs" : lines.joined(separator: "\n"), data: response)
  }

  private func tabReply(_ verb: String, _ response: JSONValue) throws -> CLIReply {
    let tab = try response.decode(TabResult.self).tab
    return CLIReply(ok: true, text: "\(verb) tab \(tab.id) \(tab.url) \(tab.title)", data: response)
  }

  private func tabClose(_ tabId: Int) async throws -> CLIReply {
    let response = try await call(.tabClose(tabId: tabId))
    return try CLIReply(ok: true, text: "closed tab \(response.decode(ClosedResult.self).closed)", data: response)
  }

  private func readPage(_ tabId: Int?, _ filter: ReadFilter, _ maxChars: Int) async throws -> CLIReply {
    let response = try await content(tabId, .readPage(filter: filter, maxChars: maxChars))
    let result = try response.decode(ReadPageResult.self)
    let truncated = result.truncated ? "\n(truncated at \(maxChars) characters)" : ""
    return CLIReply(ok: true, text: result.text + truncated, data: response)
  }

  private func find(_ tabId: Int?, _ query: String) async throws -> CLIReply {
    let response = try await content(tabId, .find(query: query))
    let lines = try response.decode(FindResult.self).matches.map(describe)
    return CLIReply(ok: true, text: lines.isEmpty ? "no matches for \"\(query)\"" : lines.joined(separator: "\n"), data: response)
  }

  private func pageText(_ tabId: Int?, _ maxChars: Int) async throws -> CLIReply {
    let response = try await content(tabId, .pageText(maxChars: maxChars))
    let result = try response.decode(PageTextResult.self)
    let truncated = result.truncated ? "\n(truncated at \(maxChars) characters)" : ""
    return CLIReply(ok: true, text: "\(result.title) | \(result.url)\n\(result.text)\(truncated)", data: response)
  }

  private func scroll(_ tabId: Int?, _ ref: Int?, _ left: Double, _ top: Double) async throws -> CLIReply {
    let response = try await content(tabId, .scroll(ref: ref, left: left, top: top))
    let result = try response.decode(ScrollResult.self)
    let position = "scroll position (\(Int(result.viewport.scrollX)), \(Int(result.viewport.scrollY)))"
    let text = result.moved ? "scrolled by (\(Int(left)), \(Int(top))); \(position)" : "nothing moved: already at the edge or not scrollable; \(position)"
    return CLIReply(ok: true, text: text, data: response)
  }

  /// Returns the PNG as base64 in data.png; the CLI writes it to a file and the MCP server returns it as image content.
  private func screenshot(_ tabId: Int?) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let response = try await call(.screenshot(tabId: tab.id))
    let result = try response.decode(ScreenshotResult.self)

    guard result.dataUrl.hasPrefix("data:image/png;base64,"), let comma = result.dataUrl.firstIndex(of: ",") else {
      throw Failure(description: "screenshot response is not a base64 PNG data URL: \(result.dataUrl.prefix(40))")
    }

    let base64 = String(result.dataUrl[result.dataUrl.index(after: comma)...])
    let data: JSONValue = .object(["png": .string(base64), "tab": response["tab"] ?? .null])
    return CLIReply(ok: true, text: "screenshot of tab \(result.tab.id) \(result.tab.url)", data: data)
  }

  /// Locate, then refuse to act when the content script says the point would land on something else.
  func locateHittable(_ tabId: Int, _ ref: Int) async throws -> LocateResult {
    let located = try await content(tabId, .locate(ref: ref)).decode(LocateResult.self)

    if !located.hitsTarget { throw Failure(description: "ref \(ref) is not hittable: \(located.hitDescription)") }

    return located
  }

  func hitLines(_ locate: LocateResult, _ hit: AXEngine.Hit) -> [String] {
    [
      "locate: hitsTarget=\(locate.hitsTarget) \(locate.hitDescription)",
      "mapped css (\(locate.point.left), \(locate.point.top)) to screen \(AXEngine.format(hit.screenPoint)) zoom \(String(format: "%.3f", hit.zoom)) frame \(AXEngine.format(hit.viewportFrame))",
      "hit: \(hit.node.summary) in window \(hit.target.window.summary)",
    ]
  }

  private func click(_ tabId: Int?, _ ref: Int) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let located = try await locateHittable(tab.id, ref)
    let hit = try await AXEngine.hitTest(css: CGPoint(x: located.point.left, y: located.point.top), viewport: located.viewport, tab: tab)
    let (pressed, depth) = try AXEngine.press(hit)
    let lines = ["pressed \(pressed.summary) via AXPress (\(depth) up from hit) in tab \(tab.id)"] + hitLines(located, hit)
    let data: JSONValue = .object([
      "tabId": .number(Double(tab.id)),
      "ref": .number(Double(ref)),
      "pressedRole": .string(pressed.role),
      "pressedLabel": .string(pressed.label),
      "action": .string(kAXPressAction),
      "depth": .number(Double(depth)),
      "hitRole": .string(hit.node.role),
      "hitDescription": .string(located.hitDescription),
      "screenPoint": .array([.number(hit.screenPoint.x), .number(hit.screenPoint.y)]),
    ])
    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: data)
  }

  private func type(_ tabId: Int?, _ ref: Int, _ text: String) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let located = try await locateHittable(tab.id, ref)
    let hit = try await AXEngine.hitTest(css: CGPoint(x: located.point.left, y: located.point.top), viewport: located.viewport, tab: tab)
    let outcome = try AXEngine.type(text, into: hit)
    let matched = outcome.readBack == text
    let lines = [
      "AXFocused=true on \(outcome.focused.summary): \(outcome.focusResult.name)",
      "AXValue on \(outcome.valueNode.summary): \(outcome.valueResult.name)",
      "read back: \(outcome.readBack.map { "\"\($0)\"" } ?? "nil") \(matched ? "(matches)" : "(DIFFERS)")",
    ] + hitLines(located, hit)
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

  /// Dumps the AX windows and frames next to the content script's viewport so window matching and mapping can be calibrated in one run.
  private func debugAX(_ tabId: Int?, _ ref: Int?) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let snapshot = try await content(tab.id, .snapshot).decode(SnapshotResult.self)
    let viewport = snapshot.viewport
    let target = try await AXEngine.target(for: tab)
    let windowFrame = tab.windowFrame.map { "(\($0.left), \($0.top), \($0.width) x \($0.height))" } ?? "none"
    var lines = [
      "tab: \(describe(tab)) windowFrame \(windowFrame)",
      "viewport: inner \(viewport.innerWidth)x\(viewport.innerHeight) client \(viewport.clientWidth ?? -1)x\(viewport.clientHeight ?? -1) visual \(viewport.visualWidth ?? -1)x\(viewport.visualHeight ?? -1)",
      "  scroll (\(viewport.scrollX), \(viewport.scrollY)) dpr \(viewport.devicePixelRatio) visualScale \(viewport.visualScale) visualOffset (\(viewport.visualOffsetLeft), \(viewport.visualOffsetTop))",
      "windows:",
    ] + target.candidates.map { "  \($0.summary)" } + [
      "matched window: \(target.window.summary) \(AXEngine.format(target.window.frame))",
      "web areas: \(target.webAreas.count)",
    ]

    for webArea in target.webAreas {
      lines.append("  AXWebArea \(AXEngine.format(webArea.frame)) url \(webArea.string("AXURL") ?? "?")")

      for ancestor in sequence(first: webArea, next: \.parent).dropFirst().prefix(6) {
        lines.append("    < \(ancestor.summary) \(AXEngine.format(ancestor.frame))")
      }
    }

    for (name, frame) in [("webArea", target.webArea.frame), ("scrollArea", target.scrollArea?.frame)] {
      guard let frame else { continue }

      let innerScale = ViewportMapping.zoom(viewport: viewport, frame: frame) * viewport.visualScale
      let visualScale = ViewportMapping.visualZoom(viewport: viewport, frame: frame).map { String(format: "%.3f", $0) } ?? "?"
      lines.append("candidate \(name) \(AXEngine.format(frame)): W/innerWidth*visualScale \(String(format: "%.3f", innerScale)), W/visualWidth \(visualScale)")
    }

    if let ref {
      let located = try await content(tab.id, .locate(ref: ref)).decode(LocateResult.self)
      let hit = try await AXEngine.hitTest(css: CGPoint(x: located.point.left, y: located.point.top), viewport: located.viewport, tab: tab)
      lines += hitLines(located, hit)
      lines.append("chain to web area:\n\(AXEngine.describe(hit.chain))")
    }

    let text = lines.joined(separator: "\n")
    return CLIReply(ok: true, text: text, data: .object(["text": .string(text)]))
  }
}
