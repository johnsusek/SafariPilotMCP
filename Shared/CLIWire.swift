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
  case type(tabId: Int?, ref: Int, text: String)
  case events(tabId: Int?, clear: Bool)
  case tabs
  case tabCreate(url: String?)
  case tabSelect(tabId: Int)
  case tabClose(tabId: Int)
  case navigate(tabId: Int?, url: String)
  case history(tabId: Int?, direction: HistoryDirection)
  case readPage(tabId: Int?, filter: ReadFilter, maxChars: Int)
  case find(tabId: Int?, query: String)
  case pageText(tabId: Int?, maxChars: Int)
  case scroll(tabId: Int?, ref: Int?, left: Double, top: Double)
  case screenshot(tabId: Int?)
  case debugAX(tabId: Int?, ref: Int?)

  static let defaultMaxChars = 50000
  static let scrollStep = 100.0

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
}
