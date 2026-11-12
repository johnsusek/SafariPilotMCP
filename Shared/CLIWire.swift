/// CLI to app: the app does the work and returns both readable text and structured data.
struct CLIRequest: Codable, Sendable {
  var kind = "cli"
  let command: AppCommand
  let timeoutSeconds: Double

  /// The background can take up to 30 s to wake and loads wait up to 15 s, so a whole command gets 60 s.
  static let defaultTimeout = 60.0
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
  case click(tabId: Int?, ref: Int)
  case formInput(tabId: Int?, ref: Int, value: FormValue)
  case events(tabId: Int?, clear: Bool)
  case tabs
  case tabCreate(url: String?)
  case tabSelect(tabId: Int)
  case tabClose(tabId: Int)
  case navigate(tabId: Int?, url: String)
  case history(tabId: Int?, direction: HistoryDirection)
  case readPage(tabId: Int?, filter: ReadFilter, maxChars: Int)
  case find(tabId: Int?, name: String, role: String)
  case pageText(tabId: Int?, maxChars: Int)
  case scroll(tabId: Int?, ref: Int?, left: Double, top: Double)
  /// Presses chords in order, the whole sequence `times` times, after focusing ref when given.
  case key(tabId: Int?, chords: [KeyChord], ref: Int?, times: Int)
  case screenshot(tabId: Int?)
  case debugAX(tabId: Int?, ref: Int?)
  /// windowFields sets the window-under-pointer fields on mouse posts.
  case debugCG(tabId: Int?, probe: CGProbe, windowFields: Bool)

  static let defaultMaxChars = 50000
  static let scrollStep = 100.0
  static let maxKeyPresses = 100

  /// "back" and "forward" walk history; anything else is a URL to load.
  static func navigation(tabId: Int?, target: String) -> AppCommand {
    guard let direction = HistoryDirection(rawValue: target) else { return .navigate(tabId: tabId, url: target) }
    return .history(tabId: tabId, direction: direction)
  }

  /// Scrolls `amount` steps of `scrollStep` CSS px.
  static func scroll(tabId: Int?, ref: Int?, direction: String, amount: Double) throws -> AppCommand {
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
  static func key(tabId: Int?, keys: String?, text: String?, ref: Int?, times: Int) throws -> AppCommand {
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

/// What form_input sets: text for a text field or a select's option value or label, checked for a checkbox or radio, which also accepts the text "true" or "false".
enum FormValue: Codable, Sendable, Equatable {
  case text(String)
  case checked(Bool)
}

/// The Quartz input debug-cg posts; refs are page element refs.
enum CGProbe: Codable, Sendable, Equatable {
  case key(KeyChord, ref: Int?)
  case click(ref: Int)
  case hover(ref: Int)
  case drag(from: Int, to: Int)

  var isKey: Bool { if case .key = self { true } else { false } }
}
