import Foundation
import UniformTypeIdentifiers

/// CLI to app: the app does the work and returns both readable text and structured data.
struct CLIRequest: Codable, Sendable {
  var kind = "cli"
  let command: AppCommand
  let timeoutSeconds: Double
  /// The key an approved hello returned; the app refuses commands without a live one, except status (and anything in Debug builds).
  var session: String?

  /// The background can take up to 30 s to wake and loads wait up to 15 s, so a whole command gets 60 s.
  static let defaultTimeout = 60.0
}

/// MCP server to app, before its first command: asks the person to approve the client. The reply blocks until they decide.
struct HelloRequest: Codable, Sendable {
  var kind = "hello"
  let clientName: String
  let clientVersion: String
  let credential: String?
  /// The MCP server's process id; the app ends the session once that process is gone.
  let pid: Int32

  /// The environment variable in the client's MCP settings that carries its credential.
  static let credentialVariable = "SAFARIPILOT_CREDENTIAL"
  /// The approval dialog expires after 120 s, so the exchange waits a little longer.
  static let timeoutSeconds = 130
}

/// A session key when approved, else why not.
struct HelloReply: Codable, Sendable {
  let session: String?
  let text: String

  var approvedSession: String {
    get throws {
      guard let session else { throw Failure(.approvalRequired, text) }
      return session
    }
  }
}

/// code is set on every failed reply and nil on a success.
struct CLIReply: Codable, Sendable {
  let ok: Bool
  let text: String
  let data: JSONValue
  var code: ErrorCode?
  /// How long the app spent on the command and on each phase; the MCP server leaves it out of what it answers.
  var timing: CommandTiming?
}

extension CLIReply {
  init(failing code: ErrorCode, text: String, data: JSONValue) {
    self.init(ok: false, text: text, data: data, code: code)
  }

  /// A failed command with its error's code; another copy of the extension also names the copies in buildMismatch, since its path is how the user finds the stale one.
  init(failed error: any Error) {
    var data: [String: JSONValue] = ["error": .string("\(error)")]

    if let mismatch = error as? BuildMismatch { data["buildMismatch"] = try? JSONValue(encoding: mismatch) }

    self.init(failing: ErrorCode(of: error), text: "\(error)", data: .object(data))
  }
}

/// One app command, shared by the CLI and the MCP server. A nil tabId means the active tab of the last focused window.
enum AppCommand: Codable, Sendable, Equatable {
  case status
  case ping(tabId: Int?)
  case snapshot(tabId: Int?)
  /// A plain left click is an AXPress; any other action or any modifier dispatches synthetic DOM events.
  case click(tabId: Int?, target: ElementTarget, action: ClickAction = .left, modifiers: [KeyChord.Modifier] = [])
  /// compat sets selects, date and time inputs and sliders through Safari's native controls and real keys, which brings the tab's window in front of the person's other Safari windows; otherwise the page script sets them.
  case formInput(tabId: Int?, target: ElementTarget, value: FormValue, compat: Bool = false)
  /// Presses ref and drags to the center of to, both in one frame, as untrusted events the page script dispatches.
  case drag(tabId: Int?, ref: PageRef, to: PageRef)
  case events(tabId: Int?, clear: Bool)
  case tabs
  /// Opens the tab in SafariPilot's window, or in a new one when none is open.
  case tabCreate(url: String?)
  case tabSelect(tabId: Int)
  case tabClose(tabId: Int)
  case navigate(tabId: Int?, url: String)
  case history(tabId: Int?, direction: HistoryDirection)
  /// ref limits the tree to that element's subtree, depth to that many levels and viewport to what shows in the view.
  case readPage(tabId: Int?, filter: ReadFilter, maxChars: Int, ref: PageRef?, depth: Int?, viewport: Bool)
  case find(tabId: Int?, name: String, role: String)
  /// ref limits the text to that element and the frames inside it.
  case pageText(tabId: Int?, maxChars: Int, format: TextFormat, ref: PageRef?)
  /// Scrolls the container around target, or the page when nil.
  case scroll(tabId: Int?, target: ElementTarget?, left: Double, top: Double)
  case scrollTo(tabId: Int?, target: ElementTarget)
  /// Presses chords in order, the whole sequence `times` times, after focusing target when given: as untrusted events from the page script,
  /// or with compat as real key presses, which go to Safari's main window and so bring the tab's window in front of the person's other Safari windows.
  case key(tabId: Int?, chords: [KeyChord], target: ElementTarget?, times: Int, compat: Bool = false)
  /// region is in the full screenshot's pixels; scale shrinks the result.
  case screenshot(tabId: Int?, region: PixelRect?, scale: Double)
  case resizeWindow(tabId: Int?, width: Int, height: Int)
  /// Runs code in the page's main world, in the frame of iframe ref frame when given; the last expression comes back as JSON.
  case javascript(tabId: Int?, code: String, frame: PageRef?)
  /// Gives the files to a file input, or drops them on any other element; the CLI or MCP process read them, so their bytes travel in the command.
  case fileUpload(tabId: Int?, target: ElementTarget, files: [UploadFile])
  /// The newest limit console messages from every frame, of errors and exceptions only when onlyErrors, whose text matches pattern; clear empties the buffers after reading.
  case consoleMessages(tabId: Int?, onlyErrors: Bool, pattern: String?, limit: Int, clear: Bool)
  /// The newest limit requests the tab made whose URL contains urlPattern, ignoring case, from the log kept for tabs tab_create opened; clear empties it after reading.
  case networkRequests(tabId: Int?, urlPattern: String?, limit: Int, clear: Bool)
  /// One logged request with its headers and, for a fetch or XMLHttpRequest call, its bodies.
  case networkRequest(tabId: Int?, requestId: String)
  /// Sends a request from the page's main world, or replays a logged one with its headers, and returns the redacted response.
  case pageFetch(tabId: Int?, request: PageFetchRequest)
  /// Presses OK (accept) or Cancel on the alert, confirm or prompt shown over the tab, typing promptText into a prompt first.
  case dialog(tabId: Int?, accept: Bool, promptText: String?)
  /// One look for the condition in every reached frame; the MCP server's wait repeats it, so no command holds the queue for a whole wait.
  case waitCheck(tabId: Int?, condition: WaitCondition)
  case debugAX(tabId: Int?, ref: PageRef?)
  /// Each frame's content script, iframes and trusted clicks and keydowns logged since the last call; a frame logs nothing before its first read.
  case debugFrames(tabId: Int?)
  /// windowFields sets the window-under-pointer fields on mouse posts.
  case debugCG(tabId: Int?, probe: CGProbe, windowFields: Bool)

  static let defaultMaxChars = 50000
  static let scrollStep = 100.0
  static let maxKeyPresses = 100
  static let scaleRange = 0.1...1.0
  /// Screenshots fit within these, the size every Claude model takes without resizing.
  static let screenshotMaxEdge = 1568.0
  static let screenshotMaxPixels = 1_150_000.0
  static let consoleLimits = 1...200
  static let defaultConsoleLimit = 50
  static let networkLimits = 1...200
  static let defaultNetworkLimit = 50

  /// corners are four numbers x0, y0, x1, y1 with the second corner below and right of the first.
  static func screenshot(tabId: Int?, corners region: [Double]?, scale: Double?) throws -> AppCommand {
    let scale = scale ?? 1

    guard scaleRange.contains(scale) else { throw Failure(.invalidArgument, "scale must be from 0.1 to 1, not \(scale)") }
    guard let region else { return .screenshot(tabId: tabId, region: nil, scale: scale) }

    let corners = region.compactMap { Int(exactly: $0.rounded()) }

    guard region.count == 4, corners.count == 4 else { throw Failure(.invalidArgument, "region must be four numbers [x0, y0, x1, y1], not \(region)") }
    guard corners.allSatisfy({ $0 >= 0 }), corners[2] > corners[0], corners[3] > corners[1] else { throw Failure(.invalidArgument, "region needs 0 <= x0 < x1 and 0 <= y0 < y1, not \(corners)") }

    return .screenshot(tabId: tabId, region: PixelRect(x0: corners[0], y0: corners[1], x1: corners[2], y1: corners[3]), scale: scale)
  }

  static func resize(tabId: Int?, width: Int, height: Int) throws -> AppCommand {
    guard width > 0, height > 0 else { throw Failure(.invalidArgument, "width and height must be positive, not \(width) x \(height)") }
    return .resizeWindow(tabId: tabId, width: width, height: height)
  }

  static func readPage(tabId: Int?, filter: ReadFilter, maxChars: Int, root: PageRef?, depth: Int?, viewport: Bool) throws -> AppCommand {
    if let depth, depth < 1 { throw Failure(.invalidArgument, "depth must be at least 1, not \(depth)") }

    return .readPage(tabId: tabId, filter: filter, maxChars: maxChars, ref: root, depth: depth, viewport: viewport)
  }

  static func javascript(tabId: Int?, text: String, frame: PageRef?) throws -> AppCommand {
    guard !text.allSatisfy(\.isWhitespace) else { throw Failure(.invalidArgument, "javascript needs some code to run") }
    return .javascript(tabId: tabId, code: text, frame: frame)
  }

  /// The command as the activity log shows it: what a client typed into a field, pressed as text or answered a prompt with is given by its size, since the log is on screen.
  var logLabel: String {
    switch self {
    case let .formInput(tabId, target, .text(text), compat): "formInput(tabId: \(String(describing: tabId)), target: \(target), value: text of \(text.count) characters, compat: \(compat))"
    case let .key(tabId, chords, target, times, compat): "key(tabId: \(String(describing: tabId)), keys: \(KeyChord.summary(chords)), target: \(String(describing: target)), times: \(times), compat: \(compat))"
    case let .dialog(tabId, accept, promptText?): "dialog(tabId: \(String(describing: tabId)), accept: \(accept), promptText: \(promptText.count) characters)"
    case let .navigate(tabId, url): "navigate(tabId: \(String(describing: tabId)), url: \(Redaction.url(url)))"
    case let .tabCreate(url?): "tabCreate(url: \(Redaction.url(url)))"
    case let .pageFetch(tabId, request): "pageFetch(tabId: \(String(describing: tabId)), \(request.logLabel))"
    default: String(describing: self)
    }
  }

  /// Measuring instruments for development; Release builds refuse them.
  var isDevTool: Bool {
    switch self {
    case .ping, .snapshot, .events, .debugAX, .debugFrames, .debugCG: true
    default: false
    }
  }

  /// The tab the command acts on, or nil for commands that act on no tab or on the active one.
  var targetTab: Int? {
    switch self {
    case .status, .tabs, .tabCreate: nil
    case let .pageFetch(tabId, _): tabId
    case let .tabSelect(tabId), let .tabClose(tabId): tabId
    case let .ping(tabId), let .snapshot(tabId), let .click(tabId, _, _, _), let .formInput(tabId, _, _, _), let .drag(tabId, _, _), let .events(tabId, _), let .navigate(tabId, _), let .history(tabId, _), let .readPage(tabId, _, _, _, _, _), let .find(tabId, _, _), let .pageText(tabId, _, _, _), let .scroll(tabId, _, _, _), let .scrollTo(tabId, _), let .resizeWindow(tabId, _, _), let .javascript(tabId, _, _), let .fileUpload(tabId, _, _), let .consoleMessages(tabId, _, _, _, _), let .networkRequests(tabId, _, _, _), let .networkRequest(tabId, _), let .dialog(tabId, _, _), let .waitCheck(tabId, _), let .key(tabId, _, _, _, _), let .screenshot(tabId, _, _), let .debugAX(tabId, _), let .debugFrames(tabId), let .debugCG(tabId, _, _): tabId
    }
  }

  /// actionName defaults to left_click; modifierNames are joined by +, like Claude in Chrome's "ctrl+shift", with meta meaning cmd.
  static func click(tabId: Int?, target: ElementTarget, actionName: String?, modifierNames: String?) throws -> AppCommand {
    let actionName = actionName ?? ClickAction.left.rawValue

    guard let action = ClickAction(rawValue: actionName) else { throw Failure(.invalidArgument, "action must be \(ClickAction.allCases.map(\.rawValue).joined(separator: ", ")), not \(actionName)") }

    var modifiers: [KeyChord.Modifier] = []

    for word in (modifierNames ?? "").split(separator: "+") {
      let name = word.lowercased()

      guard let modifier = name == "meta" ? .cmd : KeyChord.Modifier(rawValue: name) else { throw Failure(.invalidArgument, "modifiers takes ctrl, shift, alt and cmd (or meta) joined by +, not \(modifierNames ?? "")") }
      guard !modifiers.contains(modifier) else { throw Failure(.invalidArgument, "modifier \(name) repeated in \(modifierNames ?? "")") }

      modifiers.append(modifier)
    }

    return .click(tabId: tabId, target: target, action: action, modifiers: KeyChord.Modifier.allCases.filter(modifiers.contains))
  }

  /// Reads the files at paths, refusing them all when one is missing, not absolute, a directory, or together they pass maxUploadBytes.
  static func fileUpload(tabId: Int?, target: ElementTarget, paths: [String]) throws -> AppCommand {
    .fileUpload(tabId: tabId, target: target, files: try UploadFile.read(paths))
  }

  /// "accept" or "dismiss", as Playwright's dialog.accept() and dialog.dismiss().
  static func dialog(tabId: Int?, action: String, promptText: String?) throws -> AppCommand {
    guard ["accept", "dismiss"].contains(action) else { throw Failure(.invalidArgument, "action must be accept or dismiss, not \(action)") }

    return .dialog(tabId: tabId, accept: action == "accept", promptText: promptText)
  }

  /// An empty pattern matches everything, so it is sent as none.
  static func console(tabId: Int?, onlyErrors: Bool, pattern: String?, limit: Int?, clear: Bool) throws -> AppCommand {
    let limit = limit ?? defaultConsoleLimit

    guard consoleLimits.contains(limit) else { throw Failure(.invalidArgument, "limit must be from 1 to 200, not \(limit)") }

    return .consoleMessages(tabId: tabId, onlyErrors: onlyErrors, pattern: pattern?.isEmpty == false ? pattern : nil, limit: limit, clear: clear)
  }

  /// requestId picks one request, so it takes none of the listing's filters; an empty urlPattern matches everything, so it is sent as none.
  static func network(tabId: Int?, requestId: String?, urlPattern: String?, limit: Int?, clear: Bool) throws -> AppCommand {
    if let requestId {
      guard urlPattern == nil, limit == nil, !clear else { throw Failure(.invalidArgument, "requestId reads one request; leave out urlPattern, limit and clear") }
      guard !requestId.isEmpty else { throw Failure(.invalidArgument, "requestId is empty") }

      return .networkRequest(tabId: tabId, requestId: requestId)
    }

    let limit = limit ?? defaultNetworkLimit

    guard networkLimits.contains(limit) else { throw Failure(.invalidArgument, "limit must be from 1 to 200, not \(limit)") }

    return .networkRequests(tabId: tabId, urlPattern: urlPattern?.isEmpty == false ? urlPattern : nil, limit: limit, clear: clear)
  }

  /// "back" and "forward" walk history; anything else is a URL to load.
  static func navigation(tabId: Int?, target: String) -> AppCommand {
    guard let direction = HistoryDirection(rawValue: target) else { return .navigate(tabId: tabId, url: target) }
    return .history(tabId: tabId, direction: direction)
  }

  /// Scrolls `amount` steps of `scrollStep` CSS px.
  static func scroll(tabId: Int?, target: ElementTarget?, direction: String, amount: Double) throws -> AppCommand {
    let distance = amount * scrollStep

    switch direction {
    case "up": return .scroll(tabId: tabId, target: target, left: 0, top: -distance)
    case "down": return .scroll(tabId: tabId, target: target, left: 0, top: distance)
    case "left": return .scroll(tabId: tabId, target: target, left: -distance, top: 0)
    case "right": return .scroll(tabId: tabId, target: target, left: distance, top: 0)
    default: throw Failure(.invalidArgument, "scroll direction must be up, down, left or right, not \(direction)")
    }
  }

  /// Chords come from keys split on whitespace or from text one character each; cmd chords are refused because Safari acts on its own shortcuts before the page sees them.
  static func key(tabId: Int?, keys: String?, text: String?, target: ElementTarget?, times: Int, compat: Bool) throws -> AppCommand {
    let chords: [KeyChord]

    switch (keys, text) {
    case let (keys?, nil): chords = try keys.split(whereSeparator: \.isWhitespace).map { try KeyChord.parse(String($0)) }
    case let (nil, text?): chords = try text.map(KeyChord.typing)
    default: throw Failure(.invalidArgument, "key takes either keys or text, not \(keys == nil ? "neither" : "both")")
    }

    guard !chords.isEmpty else { throw Failure(.invalidArgument, "key needs at least one key, such as Enter or shift+Tab, or some text") }

    if let chord = chords.first(where: { $0.modifiers.contains(.cmd) }) {
      throw Failure(.invalidArgument, "\(chord.name) refused: Safari acts on its own shortcuts such as cmd+t and cmd+w before the page sees them, so cmd chords are not sent")
    }

    guard times >= 1 else { throw Failure(.invalidArgument, "repeat must be at least 1, not \(times)") }
    // Divided rather than multiplied, so a huge repeat cannot overflow.
    guard times <= maxKeyPresses / chords.count else { throw Failure(.invalidArgument, "\(chords.count) keys x \(times) repeats is more than the limit of \(maxKeyPresses) presses") }

    return .key(tabId: tabId, chords: chords, target: target, times: times, compat: compat)
  }
}

/// What an action acts on: a ref from read_page or find, or the one rendered element, in the frames find reads, whose accessible name contains name and whose role is role, ignoring case.
/// An exact name wins over longer ones; no match or several fail before anything acts.
enum ElementTarget: Codable, Sendable, Equatable, CustomStringConvertible {
  case ref(PageRef)
  case named(name: String, role: String)

  /// A ref, or a name and role, either of which may be left out; blank text counts as not given. Nil when nothing names a target.
  static func from(ref: PageRef?, name: String?, role: String?) throws -> ElementTarget? {
    let name = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let role = role?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    guard let ref else { return name.isEmpty && role.isEmpty ? nil : .named(name: name, role: role) }
    guard name.isEmpty, role.isEmpty else { throw Failure(.invalidArgument, "pass ref or name and role, not both") }

    return .ref(ref)
  }

  /// As find names what it looks for, such as button "Sign in".
  var description: String {
    switch self {
    case let .ref(ref): "ref \(ref)"
    case let .named(name, role): [role, name.isEmpty ? "" : "\"\(name)\""].filter { !$0.isEmpty }.joined(separator: " ")
    }
  }
}

/// What wait looks for: text a person can see on the page (case and runs of whitespace ignored), or a shown element matching a CSS selector.
enum WaitCondition: Codable, Sendable, Equatable {
  case text(String)
  case selector(String)

  /// Blank text or a blank selector would match at once, so they are refused.
  init(text: String?, selector: String?) throws {
    switch (text, selector) {
    case let (text?, nil):
      guard !text.allSatisfy(\.isWhitespace) else { throw Failure(.invalidArgument, "text to wait for is empty") }

      self = .text(text)
    case let (nil, selector?):
      guard !selector.allSatisfy(\.isWhitespace) else { throw Failure(.invalidArgument, "selector to wait for is empty") }

      self = .selector(selector)
    default:
      throw Failure(.invalidArgument, "wait takes either text or selector, not \(text == nil ? "neither" : "both")")
    }
  }

  var label: String {
    switch self {
    case let .text(text): "text \"\(text)\""
    case let .selector(selector): "selector \"\(selector)\""
    }
  }
}

/// Kinds of click, named like Claude in Chrome's computer actions.
enum ClickAction: String, Codable, Sendable, CaseIterable {
  case left = "left_click", double = "double_click", triple = "triple_click", right = "right_click"
}

/// A local file for file_upload: data is its bytes in base64, as the page script takes them; lastModified is epoch ms and mimeType "" when the extension has none, as browsers report it.
struct UploadFile: Codable, Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
  let name: String
  let mimeType: String
  let lastModified: Double
  let size: Int
  let data: String

  /// All files of one call together. Safari 27's tabs.sendMessage refuses messages over 64 MiB, which base64 reaches at 48 MiB of files; 32 MiB leaves a third of it spare.
  static let maxUploadBytes = 32 * 1_048_576

  /// The activity log prints commands, so the bytes stay out of the description.
  var description: String { "\(name) (\(size) bytes)" }
  var debugDescription: String { description }

  static func megabytes(_ bytes: Int) -> String { String(format: "%.1f MB", Double(bytes) / 1_048_576) }

  /// Sizes are checked before anything is read, so an oversized file is never loaded.
  static func read(_ paths: [String]) throws -> [UploadFile] {
    guard !paths.isEmpty else { throw Failure(.invalidArgument, "file_upload needs at least one path") }

    var total = 0
    var found: [(url: URL, size: Int, modified: Date)] = []

    for path in paths {
      guard path.hasPrefix("/") else { throw Failure(.invalidArgument, "\(path) is not an absolute path; nothing was uploaded") }

      let url = URL(filePath: path)
      let attributes: [FileAttributeKey: Any]

      // A symlink is uploaded as its target's bytes under the link's name.
      do { attributes = try FileManager.default.attributesOfItem(atPath: url.resolvingSymlinksInPath().path) } catch { throw Failure(.invalidArgument, "cannot read \(path), so nothing was uploaded: \(error.localizedDescription)") }

      guard attributes[.type] as? FileAttributeType == .typeRegular else { throw Failure(.invalidArgument, "\(path) is not a regular file; nothing was uploaded") }

      let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
      total += size

      guard total <= maxUploadBytes else {
        let together = found.isEmpty ? "is \(megabytes(size))" : "brings the files to \(megabytes(total))"
        throw Failure(.invalidArgument, "\(url.lastPathComponent) \(together), over file_upload's limit of \(megabytes(maxUploadBytes)) for all files of one call; nothing was uploaded")
      }

      found.append((url, size, attributes[.modificationDate] as? Date ?? .now))
    }

    return try found.map { url, size, modified in
      let data: Data

      do { data = try Data(contentsOf: url) } catch { throw Failure(.invalidArgument, "cannot read \(url.path), so nothing was uploaded: \(error.localizedDescription)") }

      guard data.count == size else { throw Failure(.invalidArgument, "\(url.path) changed size while being read; nothing was uploaded") }

      let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? ""
      return UploadFile(name: url.lastPathComponent, mimeType: mimeType, lastModified: (modified.timeIntervalSince1970 * 1000).rounded(), size: size, data: data.base64EncodedString())
    }
  }
}

/// A rectangle in image pixels from its top-left corner to its bottom-right corner.
struct PixelRect: Codable, Sendable, Equatable {
  let x0: Int
  let y0: Int
  let x1: Int
  let y1: Int
}

/// What form_input sets: text for a text field or a select's option value or label, checked for a checkbox or radio, which also accepts the text "true" or "false".
enum FormValue: Codable, Sendable, Equatable {
  case text(String)
  case checked(Bool)
}

/// The Quartz input debug-cg posts; refs are page element refs.
enum CGProbe: Codable, Sendable, Equatable {
  case key(KeyChord, ref: PageRef?)
  case click(ref: PageRef)
  case hover(ref: PageRef)
  case drag(from: PageRef, to: PageRef)

  var isKey: Bool { if case .key = self { true } else { false } }
}
