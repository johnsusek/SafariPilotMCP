import ApplicationServices
import Foundation

/// Mirrors of the parts of protocol.ts the app reads.
struct CSSPoint: Codable { let left: Double; let top: Double }
struct LocateResult: Codable {
  let ref: Int
  let point: CSSPoint
  let hitsTarget: Bool
  let hitDescription: String
  let viewport: Viewport
}

/// Runs one CLI command and renders it as text plus data.
@MainActor
struct Commands {
  let model: AppModel
  let timeout: Duration

  static let names = ["status", "ping", "snapshot", "click", "type", "events", "tabs", "navigate", "screenshot", "debug-ax"]

  func run(_ command: String, _ args: [String]) async throws -> CLIReply {
    switch command {
    case "status": return status()
    case "ping": return try await ping()
    case "snapshot": return try await snapshot()
    case "click": return try await click(ref(args))
    case "type": return try await type(ref(args), args.dropFirst().joined(separator: " "))
    case "events": return try await events(clear: args.contains("--clear"))
    case "tabs": return try await tabs()
    case "navigate": return try await navigate(args.first)
    case "screenshot": return try await screenshot(args.first)
    case "debug-ax": return try await debugAX(args.first.flatMap(Int.init))
    default: throw Failure(description: "unknown command \(command); commands: \(Self.names.joined(separator: ", "))")
    }
  }

  private func ref(_ args: [String]) throws -> Int {
    guard let ref = args.first.flatMap(Int.init) else { throw Failure(description: "expected a numeric ref from snapshot") }
    return ref
  }

  private func call(_ command: [String: JSONValue]) async throws -> JSONValue {
    let response = try await model.transport.send(command, timeout: timeout)

    if response["ok"]?.bool != true { throw Failure(description: "extension: \(response["error"]?.string ?? "malformed response \(response)")") }

    return response
  }

  private func content(_ request: [String: JSONValue]) async throws -> JSONValue {
    try await call(["type": "content", "request": .object(request)])
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

  private func ping() async throws -> CLIReply {
    let response = try await content(["op": "ping"])
    return CLIReply(ok: true, text: "\(response["title"]?.string ?? "")\n\(response["url"]?.string ?? "")", data: response)
  }

  private func snapshot() async throws -> CLIReply {
    let response = try await content(["op": "snapshot"])
    var lines = ["\(response["title"]?.string ?? "") | \(response["url"]?.string ?? "")"]

    for element in response["elements"]?.array ?? [] {
      let ref = Int(element["ref"]?.number ?? -1)
      let offscreen = element["inViewport"]?.bool == true ? "" : " (offscreen)"
      lines.append("[\(ref)] \(element["role"]?.string ?? "") \"\(element["name"]?.string ?? "")\" <\(element["tag"]?.string ?? "")>\(offscreen)")
    }

    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: response)
  }

  private func events(clear: Bool) async throws -> CLIReply {
    let response = try await content(["op": "events", "clear": .bool(clear)])
    var lines: [String] = []

    for event in response["events"]?.array ?? [] {
      let trusted = event["isTrusted"]?.bool == true ? "trusted" : "UNTRUSTED"
      let ref = event["ref"]?.number.map { "[\(Int($0))]" } ?? ""
      lines.append("\(event["type"]?.string ?? "") \(trusted) \(ref)\(event["target"]?.string ?? "") \(event["detail"]?.string ?? "")")
    }

    return CLIReply(ok: true, text: lines.isEmpty ? "no events" : lines.joined(separator: "\n"), data: response)
  }

  private func tabs() async throws -> CLIReply {
    let response = try await call(["type": "tabs"])
    var lines: [String] = []

    for tab in response["tabs"]?.array ?? [] {
      let marker = tab["active"]?.bool == true ? "*" : " "
      lines.append("\(marker) \(Int(tab["id"]?.number ?? -1)) w\(Int(tab["windowId"]?.number ?? -1)) \(tab["url"]?.string ?? "") \(tab["title"]?.string ?? "")")
    }

    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: response)
  }

  private func navigate(_ url: String?) async throws -> CLIReply {
    guard let url else { throw Failure(description: "expected a URL") }

    let response = try await call(["type": "navigate", "url": .string(url)])
    return CLIReply(ok: true, text: "navigating tab \(Int(response["tabId"]?.number ?? -1)) to \(url)", data: response)
  }

  private func screenshot(_ path: String?) async throws -> CLIReply {
    guard let path else { throw Failure(description: "expected an output path") }

    let response = try await call(["type": "screenshot"])

    guard let dataUrl = response["dataUrl"]?.string, let comma = dataUrl.firstIndex(of: ","), let png = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])) else {
      throw Failure(description: "screenshot response had no base64 data URL")
    }

    try png.write(to: URL(filePath: path))
    return CLIReply(ok: true, text: "saved \(path) (\(png.count) bytes)", data: .object(["path": .string(path), "bytes": .number(Double(png.count))]))
  }

  /// Locate, then refuse to act when the content script says the point would land on something else.
  private func locateHittable(_ ref: Int) async throws -> LocateResult {
    let located = try await content(["op": "locate", "ref": .number(Double(ref))]).decode(LocateResult.self)

    if !located.hitsTarget { throw Failure(description: "ref \(ref) is not hittable: \(located.hitDescription)") }

    return located
  }

  private func hitLines(_ locate: LocateResult, _ hit: AXEngine.Hit) -> [String] {
    [
      "locate: hitsTarget=\(locate.hitsTarget) \(locate.hitDescription)",
      "mapped css (\(locate.point.left), \(locate.point.top)) to screen \(AXEngine.format(hit.screenPoint)) zoom \(String(format: "%.3f", hit.zoom)) frame \(AXEngine.format(hit.viewportFrame))",
      "hit: \(hit.node.summary)",
    ]
  }

  private func click(_ ref: Int) async throws -> CLIReply {
    let located = try await locateHittable(ref)
    let hit = try AXEngine.hitTest(css: CGPoint(x: located.point.left, y: located.point.top), viewport: located.viewport)
    let (pressed, depth) = try AXEngine.press(hit)
    let lines = ["pressed \(pressed.summary) via AXPress (\(depth) up from hit)"] + hitLines(located, hit)
    let data: JSONValue = .object([
      "ref": .number(Double(ref)),
      "pressedRole": .string(pressed.role),
      "pressedLabel": .string(pressed.label),
      "action": .string(kAXPressAction),
      "depth": .number(Double(depth)),
      "hitRole": .string(hit.node.role),
      "hitsTarget": .bool(located.hitsTarget),
      "hitDescription": .string(located.hitDescription),
      "screenPoint": .array([.number(hit.screenPoint.x), .number(hit.screenPoint.y)]),
    ])
    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: data)
  }

  private func type(_ ref: Int, _ text: String) async throws -> CLIReply {
    let located = try await locateHittable(ref)
    let hit = try AXEngine.hitTest(css: CGPoint(x: located.point.left, y: located.point.top), viewport: located.viewport)
    let outcome = try AXEngine.type(text, into: hit)
    let matched = outcome.readBack == text
    let lines = [
      "AXFocused=true on \(outcome.focused.summary): \(outcome.focusResult.name)",
      "AXValue on \(outcome.valueNode.summary): \(outcome.valueResult.name)",
      "read back: \(outcome.readBack.map { "\"\($0)\"" } ?? "nil") \(matched ? "(matches)" : "(DIFFERS)")",
    ] + hitLines(located, hit)
    let data: JSONValue = .object([
      "ref": .number(Double(ref)),
      "focusedRole": .string(outcome.focused.role),
      "focusResult": .string(outcome.focusResult.name),
      "valueRole": .string(outcome.valueNode.role),
      "valueResult": .string(outcome.valueResult.name),
      "readBack": outcome.readBack.map { .string($0) } ?? .null,
      "hitsTarget": .bool(located.hitsTarget),
    ])
    let ok = outcome.focusResult == .success && outcome.valueResult == .success && matched
    return CLIReply(ok: ok, text: lines.joined(separator: "\n"), data: data)
  }

  /// Dumps the AX frames next to the content script's viewport so the mapping can be calibrated in one run.
  private func debugAX(_ ref: Int?) async throws -> CLIReply {
    let snapshot = try await content(["op": "snapshot"])
    let viewport = try (snapshot["viewport"] ?? .null).decode(Viewport.self)
    let target = try AXEngine.target()
    var lines = [
      "viewport: inner \(viewport.innerWidth)x\(viewport.innerHeight) client \(viewport.clientWidth ?? -1)x\(viewport.clientHeight ?? -1) visual \(viewport.visualWidth ?? -1)x\(viewport.visualHeight ?? -1)",
      "  scroll (\(viewport.scrollX), \(viewport.scrollY)) dpr \(viewport.devicePixelRatio) visualScale \(viewport.visualScale) visualOffset (\(viewport.visualOffsetLeft), \(viewport.visualOffsetTop))",
      "page: \(snapshot["url"]?.string ?? "")",
      "window: \(target.window.summary) \(AXEngine.format(target.window.frame))",
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
      let located = try await content(["op": "locate", "ref": .number(Double(ref))]).decode(LocateResult.self)
      let hit = try AXEngine.hitTest(css: CGPoint(x: located.point.left, y: located.point.top), viewport: located.viewport)
      lines += hitLines(located, hit)
      lines.append("chain to web area:\n\(AXEngine.describe(hit.chain))")
    }

    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: .object(["text": .string(lines.joined(separator: "\n")), "viewport": snapshot["viewport"] ?? .null]))
  }
}
