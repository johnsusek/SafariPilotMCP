/// The tabs each MCP session owns, keyed by its session key ("" for the Debug CLI's session-less commands), and the window its new tabs open in.
/// A tab joins a session when the session opens it with tab_create or when one of its tabs opens it; pilot tabs no live session owns are closed.
struct SessionTabs: Equatable, Sendable {
  struct Owned: Equatable, Sendable {
    var tabs: Set<Int> = []
    var window: Int?
  }

  private(set) var sessions: [String: Owned] = [:]

  func owns(_ key: String, _ tab: Int) -> Bool { sessions[key]?.tabs.contains(tab) == true }

  func owner(of tab: Int) -> String? { sessions.first { $0.value.tabs.contains(tab) }?.key }

  /// The session's window while every tab in it is the session's; nil means tab_create opens a new one.
  func window(for key: String, in tabs: [TabInfo]) -> Int? {
    guard let window = sessions[key]?.window else { return nil }

    let inWindow = tabs.filter { $0.windowId == window }

    guard !inWindow.isEmpty, inWindow.allSatisfy({ owns(key, $0.id) }) else { return nil }

    return window
  }

  mutating func opened(_ tab: TabInfo, by key: String) {
    sessions[key, default: Owned()].tabs.insert(tab.id)
    sessions[key]?.window = tab.windowId
  }

  mutating func closed(_ tab: Int) {
    for key in sessions.keys { sessions[key]?.tabs.remove(tab) }
  }

  /// Forgets tabs no longer open, then gives each tab whose opener a session owns to that session, repeating so a popup's popup joins too. Returns each session's newly adopted tabs.
  mutating func adopt(_ tabs: [TabInfo]) -> [String: [TabInfo]] {
    let open = Set(tabs.map(\.id))
    var adopted: [String: [TabInfo]] = [:]

    for key in sessions.keys { sessions[key]?.tabs.formIntersection(open) }

    while true {
      let found = tabs.compactMap { tab in owner(of: tab.id) == nil ? tab.openerId.flatMap(owner).map { (tab, $0) } : nil }

      if found.isEmpty { return adopted }

      for (tab, key) in found {
        sessions[key]?.tabs.insert(tab.id)
        adopted[key, default: []].append(tab)
      }
    }
  }

  /// Ends the sessions not in live and returns the pilot tabs no live session owns, after adopting popups into the live ones.
  mutating func orphans(live: Set<String>, in tabs: [TabInfo]) -> [Int] {
    sessions = sessions.filter { live.contains($0.key) }
    _ = adopt(tabs)
    return tabs.filter { $0.pilot && owner(of: $0.id) == nil }.map(\.id)
  }
}
