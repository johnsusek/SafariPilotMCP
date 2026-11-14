/// The tabs one MCP server process may see and act on: those it opened with tab_create and, transitively, tabs they opened. `current` is the default tab for page tools.
struct TabSession: Equatable, Sendable {
  var owned: Set<Int> = []
  var current: Int?

  static let noCurrent = "No session tab: call tab_create to open one."

  /// An explicit tabId wins; otherwise the session's tab; never the user's active tab.
  func page(_ explicit: Int?) throws -> Int {
    guard let tab = explicit ?? current else { throw Failure(.tabUnavailable, Self.noCurrent) }
    return tab
  }

  func visible(_ tabs: [TabInfo]) -> [TabInfo] { tabs.filter { owned.contains($0.id) } }

  /// Forgets tabs no longer open, then adopts tabs whose opener is owned, repeating so a popup's popup joins too. Returns the newly adopted tabs.
  mutating func adopt(_ tabs: [TabInfo]) -> [TabInfo] {
    let open = Set(tabs.map(\.id))
    var adopted: [TabInfo] = []
    owned.formIntersection(open)

    if let current, !open.contains(current) { self.current = nil }

    while true {
      let found = tabs.filter { tab in !owned.contains(tab.id) && tab.openerId.map(owned.contains) == true }

      if found.isEmpty { return adopted }

      owned.formUnion(found.map(\.id))
      adopted += found
    }
  }

  /// A successful tab_create owns its tab and makes it current; closing a tab forgets it.
  mutating func record(_ command: AppCommand, reply: CLIReply) {
    guard reply.ok else { return }

    switch command {
    case .tabCreate:
      guard let id = reply.data["tab"]?["id"]?.number.map({ Int($0) }) else { return }

      owned.insert(id)
      current = id
    case let .tabClose(tabId):
      owned.remove(tabId)

      if current == tabId { current = nil }
    default:
      return
    }
  }
}
