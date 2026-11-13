import AppKit
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
    case let .formInput(tabId, ref, value): try await formInput(tabId, ref, value)
    case let .events(tabId, clear): try await events(tabId, clear)
    case .tabs: try await tabs()
    case let .tabCreate(url, windowId): try await tabReply("opened", call(.tabCreate(url: url, windowId: windowId)))
    case let .tabSelect(tabId): try await tabReply("selected", call(.tabSelect(tabId: tabId)))
    case let .tabClose(tabId): try await tabClose(tabId)
    case let .navigate(tabId, url): try await tabReply("loaded", call(.navigate(tabId: tabId, url: url)))
    case let .history(tabId, direction): try await tabReply("went \(direction.rawValue) to", call(.history(tabId: tabId, direction: direction)))
    case let .readPage(tabId, filter, maxChars, ref, depth): try await readPage(tabId, filter, maxChars, ref, depth)
    case let .find(tabId, name, role): try await find(tabId, name, role)
    case let .pageText(tabId, maxChars): try await pageText(tabId, maxChars)
    case let .scroll(tabId, ref, left, top): try await scroll(tabId, ref, left, top)
    case let .scrollTo(tabId, ref): try await scrollTo(tabId, ref)
    case let .resizeWindow(tabId, width, height): try await resizeWindow(tabId, width, height)
    case let .javascript(tabId, code, frame): try await javascript(tabId, code, frame)
    case let .key(tabId, chords, ref, times): try await key(tabId, chords, ref, times)
    case let .screenshot(tabId, region, scale): try await screenshot(tabId, region, scale)
    case let .debugAX(tabId, ref): try await debugAX(tabId, ref)
    case let .debugFrames(tabId): try await debugFrames(tabId)
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


  func describe(_ event: LoggedEvent) -> String {
    let count = event.count > 1 ? " x\(event.count)" : ""
    return "\(event.type) \(event.isTrusted ? "trusted" : "UNTRUSTED") \(event.ref.map { "[\($0)]" } ?? "")\(event.target) \(event.detail)\(count)"
  }

  private func describe(_ element: ElementInfo) -> String {
    let offscreen = element.inViewport ? "" : " (offscreen)"
    let disabled = element.disabled == true ? " (disabled)" : ""
    let name = element.name.isEmpty ? "" : " \"\(element.name)\""
    return "[\(element.ref)] \(element.role)\(name) <\(element.tag)>\(offscreen)\(disabled)"
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
    let response = try await content(tabId, .events(clear: clear, arm: false, watch: nil))
    let lines = try response.decode(EventsResult.self).events.map(describe)
    return CLIReply(ok: true, text: lines.isEmpty ? "no events" : lines.joined(separator: "\n"), data: response)
  }

  private func tabs() async throws -> CLIReply {
    let response = try await call(.tabs)
    let lines = try response.decode(TabsResult.self).tabs.map(\.line)
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

  private func readPage(_ tabId: Int?, _ filter: ReadFilter, _ maxChars: Int, _ ref: PageRef?, _ depth: Int?) async throws -> CLIReply {
    let response = try await content(tabId, .readPage(filter: filter, maxChars: maxChars, ref: ref, depth: depth))
    let result = try response.decode(ReadPageResult.self)
    let truncated = result.truncated ? "\n(truncated at \(maxChars) characters)" : ""

    if result.text.isEmpty {
      let shown = filter == .interactive ? "no visible actionable elements" : "no visible elements"
      return CLIReply(ok: true, text: "\(shown) on \(result.title) | \(result.url)", data: response)
    }

    return CLIReply(ok: true, text: result.text + truncated, data: response)
  }

  private func find(_ tabId: Int?, _ name: String, _ role: String) async throws -> CLIReply {
    let response = try await content(tabId, .find(name: name, role: role))
    let lines = try response.decode(FindResult.self).matches.map(describe)
    let wanted = [role, name.isEmpty ? "" : "\"\(name)\""].filter { !$0.isEmpty }.joined(separator: " ")
    return CLIReply(ok: true, text: lines.isEmpty ? "no matches for \(wanted)" : lines.joined(separator: "\n"), data: response)
  }

  private func pageText(_ tabId: Int?, _ maxChars: Int) async throws -> CLIReply {
    let response = try await content(tabId, .pageText(maxChars: maxChars))
    let result = try response.decode(PageTextResult.self)
    let truncated = result.truncated ? "\n(truncated at \(maxChars) characters)" : ""
    return CLIReply(ok: true, text: "\(result.title) | \(result.url)\n\(result.text)\(truncated)", data: response)
  }

  private func scroll(_ tabId: Int?, _ ref: PageRef?, _ left: Double, _ top: Double) async throws -> CLIReply {
    let response = try await content(tabId, .scroll(ref: ref, left: left, top: top))
    let result = try response.decode(ScrollResult.self)
    let position = "scroll position (\(Int(result.viewport.scrollX)), \(Int(result.viewport.scrollY)))"
    let text = result.moved ? "scrolled by (\(Int(left)), \(Int(top))); \(position)" : "nothing moved: already at the edge or not scrollable; \(position)"
    return CLIReply(ok: true, text: text, data: response)
  }

  private func scrollTo(_ tabId: Int?, _ ref: PageRef) async throws -> CLIReply {
    let response = try await content(tabId, .scrollIntoView(ref: ref))
    let result = try response.decode(ScrollResult.self)
    let position = "scroll position (\(Int(result.viewport.scrollX)), \(Int(result.viewport.scrollY)))"
    return CLIReply(ok: true, text: "\(result.moved ? "scrolled ref \(ref) into view" : "ref \(ref) was already in view"); \(position)", data: response)
  }

  private func javascript(_ tabId: Int?, _ code: String, _ frame: PageRef?) async throws -> CLIReply {
    let response = try await call(.javascript(tabId: tabId, code: code, frame: frame))
    return try CLIReply(ok: true, text: response.decode(JavascriptResult.self).json ?? "undefined", data: response)
  }

  /// Safari may clamp the size to the screen, so the reply reports the frame it actually got.
  /// Sizes past the window's screen are refused, since Safari keeps an oversized width and leaves the window partly off screen.
  private func resizeWindow(_ tabId: Int?, _ width: Int, _ height: Int) async throws -> CLIReply {
    let current = try await call(.tab(tabId: tabId)).decode(TabResult.self).tab
    let room = try ScreenFit.room(for: current.windowFrame, screens: NSScreen.screens.map { ($0.frame, $0.visibleFrame) })

    guard Double(width) <= room.width, Double(height) <= room.height else { throw Failure(description: "\(width) x \(height) does not fit the \(Int(room.width)) x \(Int(room.height)) points free on the window's screen") }

    let response = try await call(.resize(tabId: current.id, width: width, height: height))
    let tab = try response.decode(TabResult.self).tab

    guard let frame = tab.windowFrame else { return CLIReply(ok: true, text: "resized window w\(tab.windowId); its new frame is unknown", data: response) }

    let size = "\(Int(frame.width)) x \(Int(frame.height))"
    let text = Int(frame.width) == width && Int(frame.height) == height ? "resized window w\(tab.windowId) to \(size)" : "asked for \(width) x \(height); window w\(tab.windowId) is \(size)"
    return CLIReply(ok: true, text: text, data: response)
  }

  /// Returns the PNG as base64 in data.png; the CLI writes it to a file and the MCP server returns it as image content.
  private func screenshot(_ tabId: Int?, _ region: PixelRect?, _ scale: Double) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let response = try await call(.screenshot(tabId: tab.id))
    let result = try response.decode(ScreenshotResult.self)

    guard result.dataUrl.hasPrefix("data:image/png;base64,"), let comma = result.dataUrl.firstIndex(of: ",") else {
      throw Failure(description: "screenshot response is not a base64 PNG data URL: \(result.dataUrl.prefix(40))")
    }

    guard let png = Data(base64Encoded: String(result.dataUrl[result.dataUrl.index(after: comma)...])) else { throw Failure(description: "screenshot data URL is not valid base64") }

    let image = try ScreenshotImage.process(png, region: region, scale: scale)
    let frame = "\(image.frameWidth) x \(image.frameHeight) px view"
    let part = region.map { " region [\($0.x0), \($0.y0), \($0.x1), \($0.y1)] of its" } ?? ""
    let size = region != nil || scale != 1 ? "; image is \(image.width) x \(image.height) px" : ""
    let data: JSONValue = .object(["png": .string(image.png.base64EncodedString()), "tab": response["tab"] ?? .null])
    return CLIReply(ok: true, text: "screenshot of tab \(result.tab.id) \(result.tab.url),\(part) \(frame)\(size)", data: data)
  }

  /// Locate, then refuse to act when the content script says the point would land on something else.
  /// Pressing needs the element on top, as a person would; focusing and typing reach a covered field too (npm's search box sits under an invisible button once typed in).
  func locateHittable(_ tabId: Int, _ ref: PageRef, coveredOK: Bool = false) async throws -> LocateResult {
    let located = try await content(tabId, .locate(ref: ref)).decode(LocateResult.self)

    if !located.hitsTarget, !(coveredOK && located.covered) {
      let hint = located.covered ? "; key Enter or Space with this ref reaches it from the keyboard" : ""
      throw Failure(description: "ref \(ref) is not hittable: \(located.hitDescription)\(hint)")
    }

    return located
  }

  /// Listeners never run in a frame sandboxed without allow-scripts, so a click or key there could not be confirmed.
  func refuseSandboxed(_ located: LocateResult, _ action: String) throws {
    guard located.sandboxed else { return }

    throw Failure(description: "ref \(located.ref) is inside a frame sandboxed without allow-scripts, where the page's listeners never run, so \(action) there cannot be verified; nothing was sent")
  }

  func matchLines(_ locate: LocateResult, _ match: AXEngine.Match) -> [String] {
    [
      "locate: hitsTarget=\(locate.hitsTarget) \(locate.hitDescription)",
      "mapped css rect (\(locate.rect.left), \(locate.rect.top), \(locate.rect.width) x \(locate.rect.height)) to screen \(AXEngine.format(match.screenRect)) zoom \(String(format: "%.3f", match.zoom)) frame \(AXEngine.format(match.viewportFrame))",
      "matched: \(match.node.summary) \(AXEngine.format(match.node.frame)) score \(String(format: "%.2f", match.score)) in window \(match.target.window.summary)",
    ]
  }

  private func click(_ tabId: Int?, _ ref: PageRef) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let located = try await locateHittable(tab.id, ref)
    try refuseSandboxed(located, "a click")
    let match = try await AXEngine.resolve(located, tab: tab)

    // WebKit's summary (AXDisclosureTriangle) has no AXPress and pressing its details group does nothing, so it is toggled with Enter, as from the keyboard.
    if match.node.role == "AXDisclosureTriangle" {
      let reply = try await key(tab.id, [try KeyChord.parse("Enter")], ref, 1)
      return CLIReply(ok: reply.ok, text: "toggled summary ref \(ref) with Enter: \(reply.text)", data: reply.data)
    }

    // The click is logged by the frame that owns the element; a link there may navigate or remove just that frame.
    let frame = ref.frame
    let before = try await content(tab.id, .events(clear: true, arm: false, watch: ref)).decode(EventsResult.self)

    guard before.origins[frame] != nil else {
      let reason = before.busy.contains(frame) ? "did not answer within 2 s" : "could not be read"
      throw Failure(description: "the frame of iframe \(frame) \(reason), so a click on ref \(ref) could not be verified; nothing was clicked")
    }

    let matched = matchLines(located, match)
    let matchedRole = match.node.role
    let pressed = try AXEngine.press(match)
    try await Task.sleep(for: .milliseconds(150))
    let after = try? await content(tab.id, .events(clear: true, arm: false, watch: ref)).decode(EventsResult.self)
    var lines = ["pressed \(pressed.summary) via AXPress (\(pressed.depth) up from match) in tab \(tab.id)"]

    guard let after else {
      lines[0] += ", then the page stopped answering: it is navigating, or the click opened a dialog such as alert() that blocks it until dismissed"
      return CLIReply(ok: true, text: (lines + matched).joined(separator: "\n"), data: .null)
    }

    if after.busy.contains(frame) {
      lines[0] += ", then the frame of iframe \(frame) did not answer within 2 s: it is busy, or the click opened a dialog such as alert() there"
      return CLIReply(ok: true, text: (lines + matched).joined(separator: "\n"), data: .null)
    }

    let clicks = after.events.filter { $0.type == "click" && $0.isTrusted && $0.frame == frame }
    let pageNavigated = after.origin != before.origin
    let frameNavigated = !frame.isEmpty && after.replaced(frame, since: before)

    // WebKit answers AXPress on some elements, such as a custom listbox option it exposes as AXStaticText, without dispatching anything.
    if !pageNavigated, !frameNavigated, clicks.isEmpty {
      lines[0] += ", but no click reached the page; try key Enter or Space on it, or on the control that owns it"
      return CLIReply(ok: false, text: (lines + matched).joined(separator: "\n"), data: .null)
    }

    // WebKit can report a frame's elements at their old place for a while after it scrolls, so a press matched by frame can land on a neighbor.
    if !frame.isEmpty, !pageNavigated, !frameNavigated, clicks.allSatisfy({ $0.onTarget == false }) {
      lines[0] += ", but the click landed on \(clicks.last.map { describe($0) } ?? "?"), not on ref \(ref); Accessibility had probably not caught up with the frame's layout, so read_page or find again and retry"
      return CLIReply(ok: false, text: (lines + matched).joined(separator: "\n"), data: .null)
    }

    let outcome = pageNavigated ? "; the page navigated" : frameNavigated ? "; the frame of iframe \(frame) navigated or closed" : ", click on \(clicks.last.map { "\($0.ref.map { "[\($0)] " } ?? "")\($0.target)" } ?? "?")"
    lines[0] += outcome
    lines += matched
    let data: JSONValue = .object([
      "tabId": .number(Double(tab.id)),
      "ref": .string(ref.description),
      "pressedRole": .string(pressed.role),
      "pressedLabel": .string(pressed.label),
      "action": .string(kAXPressAction),
      "depth": .number(Double(pressed.depth)),
      "matchedRole": .string(matchedRole),
      "matchScore": .number(match.score),
      "hitDescription": .string(located.hitDescription),
    ])
    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: data)
  }

  /// Dumps the AX windows and frames next to the content script's viewport so window matching and mapping can be calibrated in one run.
  private func debugAX(_ tabId: Int?, _ ref: PageRef?) async throws -> CLIReply {
    let tab = try await frontTab(tabId)
    let snapshot = try await content(tab.id, .snapshot).decode(SnapshotResult.self)
    let viewport = snapshot.viewport
    let target = try await AXEngine.target(for: tab)
    let windowFrame = tab.windowFrame.map { "(\($0.left), \($0.top), \($0.width) x \($0.height))" } ?? "none"
    var lines = [
      "tab: \(tab.line) windowFrame \(windowFrame)",
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

    lines += nestedWebAreas(in: target.webArea).map { "  nested \($0)" }

    for (name, frame) in [("webArea", target.webArea.frame), ("scrollArea", target.scrollArea?.frame)] {
      guard let frame else { continue }

      let innerScale = ViewportMapping.zoom(viewport: viewport, frame: frame) * viewport.visualScale
      let visualScale = ViewportMapping.visualZoom(viewport: viewport, frame: frame).map { String(format: "%.3f", $0) } ?? "?"
      lines.append("candidate \(name) \(AXEngine.format(frame)): W/innerWidth*visualScale \(String(format: "%.3f", innerScale)), W/visualWidth \(visualScale)")
    }

    if let ref {
      let located = try await content(tab.id, .locate(ref: ref)).decode(LocateResult.self)
      let match = try await AXEngine.resolve(located, tab: tab)
      lines += matchLines(located, match)
      lines.append("chain to web area:\n\(AXEngine.describe(match.chain))")
    }

    let text = lines.joined(separator: "\n")
    return CLIReply(ok: true, text: text, data: .object(["text": .string(text)]))
  }

  /// Frame documents show up as AXWebArea elements inside the top one, if WebKit links them in.
  private func nestedWebAreas(in webArea: AXNode) -> [String] {
    var found: [String] = []
    var queue = webArea.children.map { ($0, 1) }
    var visited = 0

    while !queue.isEmpty, visited < 20000 {
      let (node, depth) = queue.removeFirst()
      visited += 1

      if node.role == "AXWebArea" {
        found.append("\(String(repeating: "  ", count: depth))AXWebArea \(AXEngine.format(node.frame)) url \(node.string("AXURL") ?? "?") children \(node.children.count)")
      }

      queue += node.children.map { ($0, node.role == "AXWebArea" ? depth + 1 : depth) }
    }

    return found
  }

  private func debugFrames(_ tabId: Int?) async throws -> CLIReply {
    let response = try await call(.frames(tabId: tabId))
    var lines: [String] = []

    func add(_ node: JSONValue, _ indent: String) {
      let id = Int(node["frameId"]?.number ?? -1)

      if let error = node["error"]?.string {
        lines.append("\(indent)frame \(id): \(error)")
        return
      }

      lines.append("\(indent)frame \(id) \(node["url"]?.string ?? "?") \"\(node["title"]?.string ?? "")\" clicks \(Int(node["clicks"]?.number ?? 0)) keydowns \(Int(node["keydowns"]?.number ?? 0))")

      for entry in node["frames"]?.array ?? [] {
        let rect = entry["box"]
        let box = [rect?["left"], rect?["top"], rect?["width"], rect?["height"]].map { String(format: "%.0f", $0?.number ?? -1) }
        let sandbox = entry["sandbox"]?.string.map { " sandbox=\"\($0)\"" } ?? ""
        lines.append("\(indent)  iframe [\(Int(entry["ref"]?.number ?? -1))] frameId \(Int(entry["frameId"]?.number ?? -1)) \(entry["src"]?.string ?? "?")\(sandbox) (\(box[0]), \(box[1]), \(box[2]) x \(box[3]))")

        if let child = entry["frame"], child != .null { add(child, indent + "    ") }
      }
    }

    add(response["tree"] ?? .null, "")
    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: response)
  }
}
