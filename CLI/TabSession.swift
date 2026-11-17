/// This MCP server process's default tab for page tools: the last one it opened with tab_create. The app owns which tabs the session may act on.
struct TabSession: Equatable, Sendable {
  var current: Int?

  static let noCurrent = "No session tab: call tab_create to open one."

  /// An explicit tabId wins; otherwise the session's tab; never the user's active tab.
  func page(_ explicit: Int?) throws -> Int {
    guard let tab = explicit ?? current else { throw Failure(.tabUnavailable, Self.noCurrent) }
    return tab
  }

  /// A successful tab_create makes its tab current; closing the current tab leaves none.
  mutating func record(_ command: AppCommand, reply: CLIReply) {
    guard reply.ok else { return }

    switch command {
    case .tabCreate:
      current = reply.data["tab"]?["id"]?.number.map { Int($0) }
    case let .tabClose(tabId) where tabId == current:
      current = nil
    default:
      return
    }
  }
}
