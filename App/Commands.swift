import AppKit
import ApplicationServices
import Foundation

/// Runs one app command against the background and AX, and renders it as text plus data. It runs on the AX actor and reaches the model, which is the main actor's, with awaits.
@AXActor
struct Commands {
  let model: AppModel
  let deadline: ContinuousClock.Instant

  func run(_ command: AppCommand) async throws -> CLIReply {
    switch command {
    case .status: await status()
    case let .ping(tabId): try await ping(tabId)
    case let .snapshot(tabId): try await snapshot(tabId)
    case .click(let tabId, let target, .left, []): try await resolving(tabId, target) { try await click(tabId, $0) }
    case let .click(tabId, target, action, modifiers): try await resolving(tabId, target) { try await syntheticClick(tabId, $0, action, modifiers) }
    case let .formInput(tabId, target, value): try await resolving(tabId, target) { try await formInput(tabId, $0, value) }
    case let .events(tabId, clear): try await events(tabId, clear)
    case .tabs: try await tabs()
    case let .tabCreate(url): try await tabReply("opened", call(.tabCreate(url: url)))
    case let .tabSelect(tabId): try await tabReply("selected", call(.tabSelect(tabId: tabId)))
    case let .tabClose(tabId): try await tabClose(tabId)
    case let .navigate(tabId, url): try await tabReply("loaded", call(.navigate(tabId: tabId, url: url)))
    case let .history(tabId, direction): try await tabReply("went \(direction.rawValue) to", call(.history(tabId: tabId, direction: direction)))
    case let .readPage(tabId, filter, maxChars, ref, depth, viewport): try await readPage(tabId, filter, maxChars, ref, depth, viewport)
    case let .find(tabId, name, role): try await find(tabId, name, role)
    case let .pageText(tabId, maxChars, format, ref): try await pageText(tabId, maxChars, format, ref)
    case let .waitCheck(tabId, condition): try await waitCheck(tabId, condition)
    case let .scroll(tabId, target?, left, top): try await resolving(tabId, target) { try await scroll(tabId, $0, left, top) }
    case let .scroll(tabId, nil, left, top): try await scroll(tabId, nil, left, top)
    case let .scrollTo(tabId, target): try await resolving(tabId, target) { try await scrollTo(tabId, $0) }
    case let .resizeWindow(tabId, width, height): try await resizeWindow(tabId, width, height)
    case let .javascript(tabId, code, frame): try await javascript(tabId, code, frame)
    case let .drag(tabId, ref, to): try await drag(tabId, ref, to)
    case let .fileUpload(tabId, target, files): try await resolving(tabId, target) { try await fileUpload(tabId, $0, files) }
    case let .consoleMessages(tabId, onlyErrors, pattern, limit, clear): try await consoleMessages(tabId, onlyErrors, pattern, limit, clear)
    case let .networkRequests(tabId, urlPattern, limit, clear): try await networkRequests(tabId, urlPattern, limit, clear)
    case let .networkRequest(tabId, requestId): try await networkRequest(tabId, requestId)
    case let .pageFetch(tabId, request): try await pageFetch(tabId, request)
    case let .dialog(tabId, accept, promptText): try await answerDialog(tabId, accept, promptText)
    case let .key(tabId, chords, target?, times): try await resolving(tabId, target) { try await key(tabId, chords, $0, times) }
    case let .key(tabId, chords, nil, times): try await key(tabId, chords, nil, times)
    case let .screenshot(tabId, region, scale): try await screenshot(tabId, region, scale)
    case let .debugAX(tabId, ref): try await debugAX(tabId, ref)
    case let .debugFrames(tabId): try await debugFrames(tabId)
    case let .debugCG(tabId, probe, windowFields): try await debugCG(tabId, probe, windowFields)
    }
  }

  /// Safari's extension stops while any page shows a dialog, so nothing is sent while one is open, and the wait ends as soon as one opens.
  /// Timing names the round trip after its content op or command type, with the native messaging around it as transport.
  func call(_ command: BackgroundCommand) async throws -> JSONValue {
    let json = command.json
    let tabId = json["tabId"]?.number.map { Int($0) }

    if let blocked = try await Timing.measure("dialog check", { try await dialogBlock(tabId) }) { throw Failure(.dialogOpen, blocked) }

    let remaining = deadline - .now

    guard remaining > .zero else { throw Failure(.timedOut, "timed out before sending \(command.type)") }

    let sent = ContinuousClock.now
    let sending = Task { try await model.transport.send(json, timeout: remaining) }
    let watching = Task { () -> (any Error)? in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(250))

        do {
          guard let blocked = try await dialogBlock(tabId) else { continue }

          sending.cancel()
          return Failure(.dialogOpen, blocked)
        } catch {
          sending.cancel()
          return error
        }
      }

      return nil
    }
    defer { watching.cancel() }
    let delivery: Transport.Delivery

    do { delivery = try await sending.value } catch is CancellationError { throw await watching.value ?? Failure(.failed, "\(command.type) was cancelled") }

    let response = delivery.response
    let trip = ContinuousClock.now - sent
    let ran = Duration.microseconds(Int((delivery.ranMs ?? 0) * 1000))
    Timing.current?.add(json["request"]?["op"]?.string ?? command.type, ran)
    Timing.current?.add("transport", trip - ran)

    if response["ok"]?.bool != true {
      guard let failure = try? response.decode(PageFailure.self) else { throw Failure(.failed, "extension (\(command.type)): malformed response \(response)") }

      // A site access failure is already worded for the user, so it is passed on as it is.
      switch failure.code {
      case .siteAccessPrompt, .siteAccessDenied: throw Failure(failure.code, failure.error)
      default: throw Failure(failure.code, "extension (\(command.type)): \(failure.error)")
      }
    }

    try await model.noteTabs(in: response)
    return response
  }

  func content(_ tabId: Int?, _ request: ContentRequest) async throws -> JSONValue {
    try await call(.content(tabId: tabId, request: request))
  }

  /// Acts on a ref as given, or on the one element a name and role pick, which the reply or failure then names first so later calls can use its ref.
  func resolving(_ tabId: Int?, _ target: ElementTarget, _ act: (PageRef) async throws -> CLIReply) async throws -> CLIReply {
    switch target {
    case let .ref(ref): return try await act(ref)
    case let .named(name, role):
      let result = try await content(tabId, .target(name: name, role: role)).decode(TargetResult.self)

      guard let match = result.match else { throw result.failure(for: target) }

      let line = "resolved to \(match.line)"

      do {
        let reply = try await act(match.ref)
        return CLIReply(ok: reply.ok, text: "\(line)\n\(reply.text)", data: reply.data, code: reply.code)
      } catch let failure as Failure {
        throw Failure(failure.code, "\(line)\n\(failure)")
      }
    }
  }

  /// Resolves the tab and makes it the active tab of its window, since AX and captureVisibleTab only see a window's visible tab.
  func frontTab(_ tabId: Int?) async throws -> TabInfo {
    let tab = try await call(.tab(tabId: tabId)).decode(TabResult.self).tab

    if tab.active { return tab }

    return try await call(.tabSelect(tabId: tab.id)).decode(TabResult.self).tab
  }

  /// A navigation an action starts is looked for until this long after its input, which click's and key's own waits already cover; one the page starts later is not waited for.
  static let navigationWatch = Duration.milliseconds(150)

  /// Waits for a page the action started loading, up to the background's 15 s load cap, and names where the tab landed. moved is false when the tab's own page stayed, as after opening a popup or loading a frame.
  func landing(_ tab: TabInfo, since acted: ContinuousClock.Instant, replaced: Bool = false) async -> (moved: Bool, lines: [String]) {
    let watch = max(.zero, Commands.navigationWatch - (.now - acted))

    do {
      let settled = try await call(.settle(tabId: tab.id, url: tab.url, watchMs: Int((watch / .milliseconds(1)).rounded(.up)))).decode(SettleResult.self)
      let moved = settled.moved(from: tab.url, replaced: replaced)
      return (moved, moved ? [settled.line] : [])
    } catch {
      return (replaced, ["could not read where tab \(tab.id) landed: \(error)"])
    }
  }

  /// Ends an action's reply with where the tab landed when its page moved, else with what the action changed on the page.
  func withOutcome(_ reply: CLIReply, _ tab: TabInfo, since acted: ContinuousClock.Instant, _ watch: ChangeWatch) async -> CLIReply {
    let landed = await landing(tab, since: acted)
    let lines = landed.moved ? landed.lines : landed.lines + [await changes(watch, since: acted)]
    return CLIReply(ok: reply.ok, text: ([reply.text] + lines).joined(separator: "\n"), data: reply.data, code: reply.code)
  }

  /// A page diff started right before an action's input; failure is why it could not start, which the reply says where the diff would be.
  struct ChangeWatch {
    let tabId: Int
    let ref: PageRef?
    let failure: String?
  }

  /// Keeps what the top frame and ref's frame show, so changes(_:since:) can say what the input changed. A diff that cannot start never stops the action.
  func watchChanges(_ tabId: Int, _ ref: PageRef?) async -> ChangeWatch {
    do {
      _ = try await content(tabId, .diffStart(ref: ref))
      return ChangeWatch(tabId: tabId, ref: ref, failure: nil)
    } catch {
      return ChangeWatch(tabId: tabId, ref: ref, failure: "\(error)")
    }
  }

  /// What the input changed, once the page is still and its requests are done, or PageDiffResult.wait after the input.
  func changes(_ watch: ChangeWatch, since acted: ContinuousClock.Instant) async -> String {
    if let failure = watch.failure { return "page changes not read: \(failure)" }

    let waitMs = max(0, Int(((PageDiffResult.wait - (.now - acted)) / .milliseconds(1)).rounded(.up)))

    do {
      return try await content(watch.tabId, .diff(ref: watch.ref, waitMs: waitMs, maxChars: PageDiffResult.maxChars)).decode(PageDiffResult.self).text
    } catch {
      return "page changes not read: \(error)"
    }
  }

  func describe(_ event: LoggedEvent) -> String {
    let count = event.count > 1 ? " x\(event.count)" : ""
    return "\(event.type) \(event.isTrusted ? "trusted" : "UNTRUSTED") \(event.ref.map { "[\($0)]" } ?? "")\(event.target) \(event.detail)\(count)"
  }

  @MainActor
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
      "build: \(model.build ?? "none")",
      "extension build: \(model.buildMismatch.map { "MISMATCH \($0)" } ?? (model.extensionBuild == nil ? "not seen yet" : "matches"))",
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
      "build": model.build.map { .string($0) } ?? .null,
      "extensionBuild": model.extensionBuild.flatMap { try? JSONValue(encoding: $0) } ?? .null,
      "buildMismatch": .bool(model.buildMismatch != nil),
      "instances": .array(instances.map { .object(["id": .string($0.id), "startedAt": .number($0.startedAt.timeIntervalSince1970), "lastSeen": .number($0.lastSeen.timeIntervalSince1970), "polls": .number(Double($0.polls))]) }),
      "lifecycle": .array(transport.lifecycle.suffix(50).map { .object(["instance": .string($0.instance), "event": .string($0.event), "at": .number($0.at.timeIntervalSince1970)]) }),
    ])
    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: data)
  }

  private func ping(_ tabId: Int?) async throws -> CLIReply {
    let response = try await content(tabId, .ping)
    let result = try response.decode(PingResult.self)
    return CLIReply(ok: true, text: "\(result.title)\n\(Redaction.url(result.url))", data: response)
  }

  private func snapshot(_ tabId: Int?) async throws -> CLIReply {
    let response = try await content(tabId, .snapshot)
    let result = try response.decode(SnapshotResult.self)
    let lines = ["\(result.title) | \(Redaction.url(result.url))"] + result.elements.map(\.line)
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
    let result = try response.decode(TabResult.self)
    let tab = result.tab
    let loading = result.loading == true ? "; the page is still loading" : ""
    let access = result.access.map { "\n\($0.error)" } ?? ""
    return CLIReply(ok: true, text: "\(verb) tab \(tab.id) \(tab.shownURL) \(tab.title)\(loading)\(access)", data: response)
  }

  private func tabClose(_ tabId: Int) async throws -> CLIReply {
    let response = try await call(.tabClose(tabId: tabId))
    return try CLIReply(ok: true, text: "closed tab \(response.decode(ClosedResult.self).closed)", data: response)
  }

  private func readPage(_ tabId: Int?, _ filter: ReadFilter, _ maxChars: Int, _ ref: PageRef?, _ depth: Int?, _ viewport: Bool) async throws -> CLIReply {
    let response = try await content(tabId, .readPage(filter: filter, maxChars: maxChars, ref: ref, depth: depth, viewport: viewport))
    let result = try response.decode(ReadPageResult.self)
    let truncated = result.truncated ? "\n(truncated at \(maxChars) characters)" : ""
    let leftOut = result.leftOut.map { "\n\($0)" } ?? ""

    if result.text.isEmpty {
      let shown = filter == .interactive ? "no visible actionable elements" : "no visible elements"
      return CLIReply(ok: true, text: "\(shown)\(viewport ? " in view" : "") on \(result.title) | \(Redaction.url(result.url))\(leftOut)", data: response)
    }

    return CLIReply(ok: true, text: result.text + truncated + leftOut, data: response)
  }

  private func find(_ tabId: Int?, _ name: String, _ role: String) async throws -> CLIReply {
    let response = try await content(tabId, .find(name: name, role: role))
    let lines = try response.decode(FindResult.self).matches.map(\.line)
    return CLIReply(ok: true, text: lines.isEmpty ? "no matches for \(ElementTarget.named(name: name, role: role))" : lines.joined(separator: "\n"), data: response)
  }

  /// A page not readable yet answers ok with pending rather than failing, so the MCP server's wait polls on through a navigation.
  private func waitCheck(_ tabId: Int?, _ condition: WaitCondition) async throws -> CLIReply {
    let response = try await content(tabId, .waitFor(condition))
    let result = try response.decode(WaitResult.self)

    if let pending = result.pending { return CLIReply(ok: true, text: "the page cannot be read yet: \(pending)", data: response) }

    guard let match = result.match else { return CLIReply(ok: true, text: "no \(condition.label) on \(result.url.map(Redaction.url) ?? "?") yet", data: response) }

    let offscreen = match.inViewport ? "" : " (offscreen)"
    return CLIReply(ok: true, text: "found \(condition.label) at [\(match.ref)] \(match.role) <\(match.tag)> \"\(match.text)\"\(offscreen)", data: response)
  }

  private func pageText(_ tabId: Int?, _ maxChars: Int, _ format: TextFormat, _ ref: PageRef?) async throws -> CLIReply {
    let response = try await content(tabId, .pageText(maxChars: maxChars, format: format, ref: ref))
    let result = try response.decode(PageTextResult.self)
    let truncated = result.truncated ? "\n(truncated at \(maxChars) characters)" : ""
    return CLIReply(ok: true, text: "\(result.title) | \(Redaction.url(result.url))\n\(result.text)\(truncated)", data: response)
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

  private func consoleMessages(_ tabId: Int?, _ onlyErrors: Bool, _ pattern: String?, _ limit: Int, _ clear: Bool) async throws -> CLIReply {
    let response = try await content(tabId, .console(onlyErrors: onlyErrors, pattern: pattern, limit: limit, clear: clear))
    return try CLIReply(ok: true, text: response.decode(ConsoleResult.self).text(cleared: clear), data: response)
  }

  private func networkRequests(_ tabId: Int?, _ urlPattern: String?, _ limit: Int, _ clear: Bool) async throws -> CLIReply {
    let response = try await call(.network(tabId: tabId, urlPattern: urlPattern, limit: limit, clear: clear))
    return try CLIReply(ok: true, text: response.decode(NetworkResult.self).text(cleared: clear), data: response)
  }

  private func networkRequest(_ tabId: Int?, _ requestId: String) async throws -> CLIReply {
    let response = try await call(.networkRequest(tabId: tabId, requestId: requestId))
    return try CLIReply(ok: true, text: response.decode(NetworkRequestResult.self).text(), data: response)
  }

  private func pageFetch(_ tabId: Int?, _ request: PageFetchRequest) async throws -> CLIReply {
    let response = try await call(.pageFetch(tabId: tabId, request: request))
    return try CLIReply(ok: true, text: response.decode(PageFetchResult.self).text, data: response)
  }

  /// Safari may clamp the size to the screen, so the reply reports the frame it actually got.
  /// Sizes past the window's screen are refused, since Safari keeps an oversized width and leaves the window partly off screen.
  private func resizeWindow(_ tabId: Int?, _ width: Int, _ height: Int) async throws -> CLIReply {
    let current = try await call(.tab(tabId: tabId)).decode(TabResult.self).tab
    let screens = await MainActor.run { NSScreen.screens.map { ($0.frame, $0.visibleFrame) } }
    let room = try ScreenFit.room(for: current.windowFrame, screens: screens)

    guard Double(width) <= room.width, Double(height) <= room.height else { throw Failure(.invalidArgument, "\(width) x \(height) does not fit the \(Int(room.width)) x \(Int(room.height)) points free on the window's screen") }

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
      throw Failure(.failed, "screenshot response is not a base64 PNG data URL: \(result.dataUrl.prefix(40))")
    }

    guard let png = Data(base64Encoded: String(result.dataUrl[result.dataUrl.index(after: comma)...])) else { throw Failure(.failed, "screenshot data URL is not valid base64") }

    let image = try ScreenshotImage.process(png, region: region, scale: scale)
    let frame = "\(image.frameWidth) x \(image.frameHeight) px view"
    let part = region.map { " region [\($0.x0), \($0.y0), \($0.x1), \($0.y1)] of its" } ?? ""
    let size = region != nil || scale != 1 ? "; image is \(image.width) x \(image.height) px" : ""
    let data: JSONValue = .object(["png": .string(image.png.base64EncodedString()), "tab": response["tab"] ?? .null])
    return CLIReply(ok: true, text: "screenshot of tab \(result.tab.id) \(result.tab.shownURL),\(part) \(frame)\(size)", data: data)
  }

  /// Locate, then refuse to act when the content script says the point would land on something else.
  /// Pressing needs the element on top, as a person would; focusing and typing reach a covered field too (npm's search box sits under an invisible button once typed in).
  func locateHittable(_ tabId: Int, _ ref: PageRef, coveredOK: Bool = false) async throws -> LocateResult {
    let located = try await content(tabId, .locate(ref: ref)).decode(LocateResult.self)

    if !located.hitsTarget, !(coveredOK && located.covered) {
      let hint = located.covered ? "; key Enter or Space with this ref reaches it from the keyboard" : ""
      throw Failure(.notActionable, "ref \(ref) is not hittable: \(located.hitDescription)\(hint)")
    }

    return located
  }

  /// Listeners never run in a frame sandboxed without allow-scripts, so a click or key there could not be confirmed.
  func refuseSandboxed(_ located: LocateResult, _ action: String) throws {
    guard located.sandboxed else { return }

    throw Failure(.notActionable, "ref \(located.ref) is inside a frame sandboxed without allow-scripts, where the page's listeners never run, so \(action) there cannot be verified; nothing was sent")
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
      return CLIReply(ok: reply.ok, text: "toggled summary ref \(ref) with Enter: \(reply.text)", data: reply.data, code: reply.code)
    }

    // The click is logged by the frame that owns the element; a link there may navigate or remove just that frame.
    let frame = ref.frame
    let before = try await content(tab.id, .events(clear: true, arm: false, watch: ref)).decode(EventsResult.self)

    try before.requireAnswered(frame, so: "a click on ref \(ref) could not be verified; nothing was clicked")

    let matched = matchLines(located, match)
    let matchedRole = match.node.role
    let watch = await watchChanges(tab.id, ref)
    let pressed = try await Timing.measure("press") { try AXEngine.press(match) }
    let acted = ContinuousClock.now
    try await Timing.sleep(for: .milliseconds(150))
    let after = try? await content(tab.id, .events(clear: true, arm: false, watch: ref)).decode(EventsResult.self)
    var lines = ["pressed \(pressed.summary) via AXPress (\(pressed.depth) up from match) in tab \(tab.id)"]

    if after == nil, let open = try await Timing.measure("dialog check", { try AXEngine.dialog(for: tab) }) {
      lines[0] += ", which opened \(open.dialog.line); handle_dialog accepts or dismisses it"
      return try CLIReply(ok: true, text: (lines + matched).joined(separator: "\n"), data: .object(["tabId": .number(Double(tab.id)), "dialog": JSONValue(encoding: open.dialog)]))
    }

    let pageNavigated = after.map { $0.origin != before.origin } ?? true
    let landed = await landing(tab, since: acted, replaced: pageNavigated)

    guard let after else {
      lines[0] += ", then the page stopped answering, most likely because it is navigating"
      return CLIReply(ok: true, text: (lines + matched + landed.lines).joined(separator: "\n"), data: .null)
    }

    if after.busy.contains(frame) {
      lines[0] += ", then the frame of iframe \(frame) did not answer within 2 s: it is busy"
      return CLIReply(ok: true, text: (lines + matched + landed.lines).joined(separator: "\n"), data: .null)
    }

    let clicks = after.events.filter { $0.type == "click" && $0.isTrusted && $0.frame == frame }
    // The old document often still answers 150 ms after a link press, so a load the tab started counts as the page navigating too.
    let navigated = pageNavigated || landed.moved
    let frameNavigated = !frame.isEmpty && after.replaced(frame, since: before)

    // WebKit answers AXPress on some elements, such as a custom listbox option it exposes as AXStaticText, without dispatching anything.
    if !navigated, !frameNavigated, clicks.isEmpty {
      lines[0] += ", but no click reached the page; try key Enter or Space on it, or on the control that owns it"
      return await CLIReply(failing: .inputUnconfirmed, text: (lines + matched + landed.lines + [changes(watch, since: acted)]).joined(separator: "\n"), data: .null)
    }

    // WebKit can report a frame's elements at their old place for a while after it scrolls, so a press matched by frame can land on a neighbor.
    if !frame.isEmpty, !navigated, !frameNavigated, clicks.allSatisfy({ $0.onTarget == false }) {
      lines[0] += ", but the click landed on \(clicks.last.map { describe($0) } ?? "?"), not on ref \(ref); Accessibility had probably not caught up with the frame's layout, so read_page or find again and retry"
      return await CLIReply(failing: .inputUnconfirmed, text: (lines + matched + landed.lines + [changes(watch, since: acted)]).joined(separator: "\n"), data: .null)
    }

    let outcome = pageNavigated || (navigated && clicks.isEmpty) ? "; the page navigated" : frameNavigated ? "; the frame of iframe \(frame) navigated or closed" : ", click on \(clicks.last.map { "\($0.ref.map { "[\($0)] " } ?? "")\($0.target)" } ?? "?")"
    lines[0] += outcome
    lines += matched + landed.lines

    if !navigated, !frameNavigated { lines.append(await changes(watch, since: acted)) }

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

  /// Double, triple, right and modifier clicks have no trusted background path, so the content script dispatches them; no AX is involved, so the tab stays where it is in its window.
  private func syntheticClick(_ tabId: Int?, _ ref: PageRef, _ action: ClickAction, _ modifiers: [KeyChord.Modifier]) async throws -> CLIReply {
    let tab = try await call(.tab(tabId: tabId)).decode(TabResult.self).tab
    let located = try await locateHittable(tab.id, ref)
    try refuseSandboxed(located, "a click")
    let held = modifiers.isEmpty ? "" : " with \(modifiers.map(\.rawValue).joined(separator: "+"))"
    let watch = await watchChanges(tab.id, ref)
    let response: JSONValue

    // A listener that opens a dialog stops the dispatch mid-sequence; the remaining events run once handle_dialog answers it.
    do { response = try await content(tab.id, .syntheticClick(ref: ref, action: action, modifiers: modifiers)) } catch {
      guard let open = try AXEngine.dialog(for: tab) else { throw error }

      let text = "dispatched a synthetic \(action.rawValue.split(separator: "_").joined(separator: " "))\(held) on ref \(ref) in tab \(tab.id), which opened \(open.dialog.line); the rest of the click's events run after handle_dialog accepts or dismisses it"
      return try CLIReply(ok: true, text: text, data: .object(["tabId": .number(Double(tab.id)), "dialog": JSONValue(encoding: open.dialog)]))
    }

    let acted = ContinuousClock.now
    let result = try response.decode(SyntheticClickResult.self)
    let events = result.dispatched.map { $0.canceled ? "\($0.type) (canceled)" : $0.type }.joined(separator: ", ")
    let text = "dispatched a synthetic \(action.rawValue.split(separator: "_").joined(separator: " "))\(held) on ref \(ref) \(result.target) in tab \(tab.id) as untrusted events: \(events); browser defaults such as text selection and the context menu do not run; focus is on \(result.focused)"
    return await withOutcome(CLIReply(ok: true, text: text, data: response), tab, since: acted, watch)
  }

  /// Untrusted events never start Safari's own drag, so the content script plays one; no AX is involved, so the tab stays where it is in its window.
  private func drag(_ tabId: Int?, _ ref: PageRef, _ to: PageRef) async throws -> CLIReply {
    let tab = try await call(.tab(tabId: tabId)).decode(TabResult.self).tab
    let located = try await locateHittable(tab.id, ref)
    try refuseSandboxed(located, "a drag")
    let watch = await watchChanges(tab.id, ref)
    let response: JSONValue

    // A listener that opens a dialog stops the drag mid-sequence; the remaining events run once handle_dialog answers it.
    do { response = try await content(tab.id, .drag(ref: ref, to: to)) } catch {
      guard let open = try AXEngine.dialog(for: tab) else { throw error }

      let text = "started a synthetic drag from ref \(ref) to ref \(to) in tab \(tab.id), which opened \(open.dialog.line); the rest of the drag runs after handle_dialog accepts or dismisses it"
      return try CLIReply(ok: true, text: text, data: .object(["tabId": .number(Double(tab.id)), "dialog": JSONValue(encoding: open.dialog)]))
    }

    let acted = ContinuousClock.now
    let result = try response.decode(DragResult.self)
    let events = result.dispatched.map { "\($0.type)\($0.count > 1 ? " x\($0.count)" : "")\($0.canceled ? " (canceled)" : "")" }.joined(separator: ", ")
    let kind = result.html5 ? "an HTML5 drag" : "a pointer drag"
    let outcome = switch (result.html5, result.dropped) {
    case (true, true): "dropped on \(result.target)"
    case (true, false): "no dragover listener on \(result.target) called preventDefault, so nothing was dropped"
    case (false, _): "released on \(result.target)"
    }
    let text = "dragged ref \(ref) \(result.source) to ref \(to) in tab \(tab.id) as \(kind) of untrusted events: \(events); \(outcome)"
    return await withOutcome(CLIReply(ok: true, text: text, data: response), tab, since: acted, watch)
  }

  /// Safari's open panel cannot be driven in the background, so the content script hands the page File objects instead; no AX is involved, so the tab stays where it is in its window.
  private func fileUpload(_ tabId: Int?, _ ref: PageRef, _ files: [UploadFile]) async throws -> CLIReply {
    let tab = try await call(.tab(tabId: tabId)).decode(TabResult.self).tab
    let watch = await watchChanges(tab.id, ref)
    let response: JSONValue

    // A change or drop listener that opens a dialog keeps the page from answering until handle_dialog closes it.
    do { response = try await content(tab.id, .upload(ref: ref, files: files)) } catch {
      guard let open = try AXEngine.dialog(for: tab) else { throw error }

      let text = "handed \(files.map(\.name).joined(separator: ", ")) to ref \(ref) in tab \(tab.id), which opened \(open.dialog.line); handle_dialog accepts or dismisses it"
      return try CLIReply(ok: true, text: text, data: .object(["tabId": .number(Double(tab.id)), "dialog": JSONValue(encoding: open.dialog)]))
    }

    let acted = ContinuousClock.now
    let result = try response.decode(UploadResult.self)
    let sent = result.files.map { "\($0.name) (\($0.size) bytes\($0.type.isEmpty ? "" : ", \($0.type)"))" }.joined(separator: ", ")
    let events = result.dispatched.map { $0.canceled ? "\($0.type) (canceled)" : $0.type }.joined(separator: ", ")
    let text = switch result.via {
    case .input: "set \(result.target) for ref \(ref) in tab \(tab.id) to \(sent) and dispatched untrusted \(events)"
    case .drop: "dropped \(sent) on \(result.target) for ref \(ref) in tab \(tab.id) as untrusted \(events)\(result.dispatched.last?.canceled == true ? "" : "; no drop listener called preventDefault, so the page may have ignored it")"
    }
    return await withOutcome(CLIReply(ok: true, text: text, data: response), tab, since: acted, watch)
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
      lines.append("  AXWebArea \(AXEngine.format(webArea.frame)) url \(webArea.string("AXURL").map(Redaction.url) ?? "?")")

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
        found.append("\(String(repeating: "  ", count: depth))AXWebArea \(AXEngine.format(node.frame)) url \(node.string("AXURL").map(Redaction.url) ?? "?") children \(node.children.count)")
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

      lines.append("\(indent)frame \(id) \(node["url"]?.string.map(Redaction.url) ?? "?") \"\(node["title"]?.string ?? "")\" clicks \(Int(node["clicks"]?.number ?? 0)) keydowns \(Int(node["keydowns"]?.number ?? 0))")

      for entry in node["frames"]?.array ?? [] {
        let rect = entry["box"]
        let box = [rect?["left"], rect?["top"], rect?["width"], rect?["height"]].map { String(format: "%.0f", $0?.number ?? -1) }
        let sandbox = entry["sandbox"]?.string.map { " sandbox=\"\($0)\"" } ?? ""
        lines.append("\(indent)  iframe [\(Int(entry["ref"]?.number ?? -1))] frameId \(Int(entry["frameId"]?.number ?? -1)) \(entry["src"]?.string.map(Redaction.url) ?? "?")\(sandbox) (\(box[0]), \(box[1]), \(box[2]) x \(box[3]))")

        if let child = entry["frame"], child != .null { add(child, indent + "    ") }
      }
    }

    add(response["tree"] ?? .null, "")
    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: response)
  }
}
