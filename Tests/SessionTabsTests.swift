import Testing

struct SessionTabsTests {
  func tab(_ id: Int, window: Int = 1, opener: Int? = nil, pilot: Bool = true) -> TabInfo { TabInfo(id: id, windowId: window, active: false, url: "https://\(id).test/", title: "", windowFrame: nil, openerId: opener, pilot: pilot) }

  @Test func eachSessionOwnsWhatItOpens() {
    var record = SessionTabs()
    record.opened(tab(5, window: 2), by: "a")
    record.opened(tab(6, window: 3), by: "b")
    #expect(record.owns("a", 5) && !record.owns("a", 6))
    #expect(record.owns("b", 6) && !record.owns("b", 5))
    record.closed(5)
    #expect(!record.owns("a", 5))
  }

  @Test func adoptsPopupsIntoTheOpenersSessionTransitively() {
    var record = SessionTabs()
    record.opened(tab(5), by: "a")
    record.opened(tab(1), by: "b")
    let tabs = [tab(1), tab(5), tab(7, opener: 9), tab(9, opener: 5), tab(3, opener: 1), tab(4, opener: 2, pilot: false)]
    let adopted = record.adopt(tabs)
    #expect(adopted["a"]?.map(\.id).sorted() == [7, 9])
    #expect(adopted["b"]?.map(\.id) == [3])
    #expect(record.owner(of: 4) == nil)
    #expect(record.adopt(tabs).isEmpty)
  }

  @Test func adoptForgetsClosedTabs() {
    var record = SessionTabs()
    record.opened(tab(5), by: "a")
    record.opened(tab(6), by: "a")
    _ = record.adopt([tab(6)])
    #expect(record.sessions["a"]?.tabs == [6])
  }

  @Test func reusesTheSessionWindowOnlyWhileItHoldsOnlyTheSessionsTabs() {
    var record = SessionTabs()
    record.opened(tab(5, window: 2), by: "a")
    record.opened(tab(6, window: 3), by: "b")
    #expect(record.window(for: "a", in: [tab(5, window: 2), tab(6, window: 3)]) == 2)
    #expect(record.window(for: "c", in: [tab(5, window: 2)]) == nil)
    // Another session's tab, or the user's, dragged into the window.
    #expect(record.window(for: "a", in: [tab(5, window: 2), tab(6, window: 2)]) == nil)
    #expect(record.window(for: "a", in: [tab(5, window: 2), tab(8, window: 2, pilot: false)]) == nil)
    // The window closed.
    #expect(record.window(for: "a", in: [tab(6, window: 3)]) == nil)
  }

  @Test func orphansArePilotTabsNoLiveSessionOwns() {
    var record = SessionTabs()
    record.opened(tab(5, window: 2), by: "a")
    record.opened(tab(6, window: 3), by: "b")
    record.opened(tab(10, window: 4), by: "")
    let tabs = [tab(5, window: 2), tab(6, window: 3), tab(7, window: 3, opener: 6), tab(8, window: 5, opener: 5), tab(10, window: 4), tab(11, window: 6), tab(12, window: 1, pilot: false)]
    #expect(record.orphans(live: ["a", ""], in: tabs).sorted() == [6, 7, 11])
    #expect(record.sessions.keys.sorted() == ["", "a"])
    #expect(record.owns("a", 8))
  }
}
