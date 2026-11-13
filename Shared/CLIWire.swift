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

  /// The environment variable in the client's MCP settings that carries its credential.
  static let credentialVariable = "SAFARIPILOT_CREDENTIAL"
  /// The approval dialog expires after 120 s, so the exchange waits a little longer.
  static let timeoutSeconds = 130
}

/// A session key when approved, else why not.
struct HelloReply: Codable, Sendable {
  let session: String?
  let text: String
}

struct CLIReply: Codable, Sendable {
  let ok: Bool
  let text: String
  let data: JSONValue
}

/// One app command, shared by the CLI and the MCP server. A nil tabId means the active tab of the last focused window.
enum AppCommand: Codable, Sendable, Equatable {
  case status
  case ping(tabId: Int?)
  case snapshot(tabId: Int?)
  /// A plain left click is an AXPress; any other action or any modifier dispatches synthetic DOM events.
  case click(tabId: Int?, ref: PageRef, action: ClickAction = .left, modifiers: [KeyChord.Modifier] = [])
  case formInput(tabId: Int?, ref: PageRef, value: FormValue)
  case events(tabId: Int?, clear: Bool)
  case tabs
  /// Opens the tab in windowId, or in a new window when it is nil or closed.
  case tabCreate(url: String?, windowId: Int?)
  case tabSelect(tabId: Int)
  case tabClose(tabId: Int)
  case navigate(tabId: Int?, url: String)
  case history(tabId: Int?, direction: HistoryDirection)
  /// ref limits the tree to that element's subtree and depth to that many levels.
  case readPage(tabId: Int?, filter: ReadFilter, maxChars: Int, ref: PageRef?, depth: Int?)
  case find(tabId: Int?, name: String, role: String)
  case pageText(tabId: Int?, maxChars: Int)
  case scroll(tabId: Int?, ref: PageRef?, left: Double, top: Double)
  case scrollTo(tabId: Int?, ref: PageRef)
  /// Presses chords in order, the whole sequence `times` times, after focusing ref when given.
  case key(tabId: Int?, chords: [KeyChord], ref: PageRef?, times: Int)
  /// region is in the full screenshot's pixels; scale shrinks the result.
  case screenshot(tabId: Int?, region: PixelRect?, scale: Double)
  case resizeWindow(tabId: Int?, width: Int, height: Int)
  case debugAX(tabId: Int?, ref: PageRef?)
  /// Each frame's content script, iframes and trusted clicks and keydowns logged since the last call.
  case debugFrames(tabId: Int?)
  /// windowFields sets the window-under-pointer fields on mouse posts.
  case debugCG(tabId: Int?, probe: CGProbe, windowFields: Bool)

  static let defaultMaxChars = 50000
  static let scrollStep = 100.0
  static let maxKeyPresses = 100
  static let scaleRange = 0.1...1.0

  /// corners are four numbers x0, y0, x1, y1 with the second corner below and right of the first.
  static func screenshot(tabId: Int?, corners region: [Double]?, scale: Double?) throws -> AppCommand {
    let scale = scale ?? 1

    guard scaleRange.contains(scale) else { throw Failure(description: "scale must be from 0.1 to 1, not \(scale)") }
    guard let region else { return .screenshot(tabId: tabId, region: nil, scale: scale) }

    let corners = region.compactMap { Int(exactly: $0.rounded()) }

    guard region.count == 4, corners.count == 4 else { throw Failure(description: "region must be four numbers [x0, y0, x1, y1], not \(region)") }
    guard corners.allSatisfy({ $0 >= 0 }), corners[2] > corners[0], corners[3] > corners[1] else { throw Failure(description: "region needs 0 <= x0 < x1 and 0 <= y0 < y1, not \(corners)") }

    return .screenshot(tabId: tabId, region: PixelRect(x0: corners[0], y0: corners[1], x1: corners[2], y1: corners[3]), scale: scale)
  }

  static func resize(tabId: Int?, width: Int, height: Int) throws -> AppCommand {
    guard width > 0, height > 0 else { throw Failure(description: "width and height must be positive, not \(width) x \(height)") }
    return .resizeWindow(tabId: tabId, width: width, height: height)
  }

  static func readPage(tabId: Int?, filter: ReadFilter, maxChars: Int, root: PageRef?, depth: Int?) throws -> AppCommand {
    if let depth, depth < 1 { throw Failure(description: "depth must be at least 1, not \(depth)") }

    return .readPage(tabId: tabId, filter: filter, maxChars: maxChars, ref: root, depth: depth)
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
    case let .tabSelect(tabId), let .tabClose(tabId): tabId
    case let .ping(tabId), let .snapshot(tabId), let .click(tabId, _, _, _), let .formInput(tabId, _, _), let .events(tabId, _), let .navigate(tabId, _), let .history(tabId, _), let .readPage(tabId, _, _, _, _), let .find(tabId, _, _), let .pageText(tabId, _), let .scroll(tabId, _, _, _), let .scrollTo(tabId, _), let .resizeWindow(tabId, _, _), let .key(tabId, _, _, _), let .screenshot(tabId, _, _), let .debugAX(tabId, _), let .debugFrames(tabId), let .debugCG(tabId, _, _): tabId
    }
  }

  /// actionName defaults to left_click; modifierNames are joined by +, like Claude in Chrome's "ctrl+shift", with meta meaning cmd.
  static func click(tabId: Int?, ref: PageRef, actionName: String?, modifierNames: String?) throws -> AppCommand {
    let actionName = actionName ?? ClickAction.left.rawValue

    guard let action = ClickAction(rawValue: actionName) else { throw Failure(description: "action must be \(ClickAction.allCases.map(\.rawValue).joined(separator: ", ")), not \(actionName)") }

    var modifiers: [KeyChord.Modifier] = []

    for word in (modifierNames ?? "").split(separator: "+") {
      let name = word.lowercased()

      guard let modifier = name == "meta" ? .cmd : KeyChord.Modifier(rawValue: name) else { throw Failure(description: "modifiers takes ctrl, shift, alt and cmd (or meta) joined by +, not \(modifierNames ?? "")") }
      guard !modifiers.contains(modifier) else { throw Failure(description: "modifier \(name) repeated in \(modifierNames ?? "")") }

      modifiers.append(modifier)
    }

    return .click(tabId: tabId, ref: ref, action: action, modifiers: KeyChord.Modifier.allCases.filter(modifiers.contains))
  }

  /// "back" and "forward" walk history; anything else is a URL to load.
  static func navigation(tabId: Int?, target: String) -> AppCommand {
    guard let direction = HistoryDirection(rawValue: target) else { return .navigate(tabId: tabId, url: target) }
    return .history(tabId: tabId, direction: direction)
  }

  /// Scrolls `amount` steps of `scrollStep` CSS px.
  static func scroll(tabId: Int?, ref: PageRef?, direction: String, amount: Double) throws -> AppCommand {
    let distance = amount * scrollStep

    switch direction {
    case "up": return .scroll(tabId: tabId, ref: ref, left: 0, top: -distance)
    case "down": return .scroll(tabId: tabId, ref: ref, left: 0, top: distance)
    case "left": return .scroll(tabId: tabId, ref: ref, left: -distance, top: 0)
    case "right": return .scroll(tabId: tabId, ref: ref, left: distance, top: 0)
    default: throw Failure(description: "scroll direction must be up, down, left or right, not \(direction)")
    }
  }

  /// Chords come from keys split on whitespace or from text one character each; cmd chords are refused because Safari acts on its own shortcuts before the page sees them.
  static func key(tabId: Int?, keys: String?, text: String?, ref: PageRef?, times: Int) throws -> AppCommand {
    let chords: [KeyChord]

    switch (keys, text) {
    case let (keys?, nil): chords = try keys.split(whereSeparator: \.isWhitespace).map { try KeyChord.parse(String($0)) }
    case let (nil, text?): chords = try text.map(KeyChord.typing)
    default: throw Failure(description: "key takes either keys or text, not \(keys == nil ? "neither" : "both")")
    }

    let presses = chords.count * times

    guard !chords.isEmpty else { throw Failure(description: "key needs at least one key, such as Enter or shift+Tab, or some text") }

    if let chord = chords.first(where: { $0.modifiers.contains(.cmd) }) {
      throw Failure(description: "\(chord.name) refused: Safari acts on its own shortcuts such as cmd+t and cmd+w before the page sees them, so cmd chords are not sent")
    }

    guard times >= 1 else { throw Failure(description: "repeat must be at least 1, not \(times)") }
    guard presses <= maxKeyPresses else { throw Failure(description: "\(chords.count) keys x \(times) repeats is \(presses) presses; the limit is \(maxKeyPresses)") }

    return .key(tabId: tabId, chords: chords, ref: ref, times: times)
  }
}

/// Kinds of click, named like Claude in Chrome's computer actions.
enum ClickAction: String, Codable, Sendable, CaseIterable {
  case left = "left_click", double = "double_click", triple = "triple_click", right = "right_click"
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
