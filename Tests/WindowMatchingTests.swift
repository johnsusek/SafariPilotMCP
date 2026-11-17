import CoreGraphics
import Testing

struct WindowMatchingTests {
  func tab(_ url: String, frame: CSSRect? = nil) -> TabInfo { TabInfo(id: 5, windowId: 2, active: true, url: url, title: "Page", windowFrame: frame, openerId: nil, pilot: false) }

  func window(_ urls: [String], at frame: CGRect? = CGRect(x: 0, y: 25, width: 1200, height: 800), minimized: Bool = false) -> WindowCandidate {
    WindowCandidate(title: "W", frame: frame, minimized: minimized, urls: urls)
  }

  @Test func picksTheWindowShowingTheUrl() throws {
    let candidates = [window(["https://a.test/"]), window(["https://b.test/page"])]
    #expect(try WindowMatching.match(tab: tab("https://b.test/page"), candidates: candidates) == 1)
  }

  @Test func ignoresFragmentAndTrailingSlash() throws {
    #expect(try WindowMatching.match(tab: tab("https://a.test/#top"), candidates: [window(["https://a.test"])]) == 0)
    #expect(WindowMatching.normalize("https://a.test/path/?q=1#x") == "https://a.test/path/?q=1")
  }

  @Test func looksAtEveryWebAreaInAWindow() throws {
    #expect(try WindowMatching.match(tab: tab("https://b.test/"), candidates: [window(["https://a.test/", "https://b.test/"])]) == 0)
  }

  @Test func windowFrameBreaksTies() throws {
    let candidates = [window(["https://a.test/"], at: CGRect(x: 0, y: 25, width: 1200, height: 800)), window(["https://a.test/"], at: CGRect(x: 300, y: 100, width: 900, height: 700))]
    #expect(try WindowMatching.match(tab: tab("https://a.test/", frame: CSSRect(left: 300, top: 100, width: 900, height: 700)), candidates: candidates) == 1)
    #expect(try WindowMatching.match(tab: tab("https://a.test/", frame: CSSRect(left: 2, top: 25, width: 1200, height: 800)), candidates: candidates) == 0)
  }

  @Test func singleUrlMatchStandsWhenNoWindowIsAtTheTabsFrame() throws {
    let candidates = [window(["https://a.test/"], at: CGRect(x: 0, y: 25, width: 1200, height: 800)), window(["https://b.test/"], at: CGRect(x: 300, y: 100, width: 900, height: 700))]
    #expect(try WindowMatching.match(tab: tab("https://a.test/", frame: CSSRect(left: 900, top: 900, width: 10, height: 10)), candidates: candidates) == 0)
    #expect(try WindowMatching.match(tab: tab("https://a.test/", frame: CSSRect(left: 2, top: 25, width: 1200, height: 800)), candidates: candidates) == 0)
  }

  @Test func loneMatchInAnotherWindowWaitsForTheTabsOwn() {
    let candidates = [window(["https://a.test/"], at: CGRect(x: 0, y: 25, width: 1200, height: 800)), window([], at: CGRect(x: 300, y: 100, width: 900, height: 700))]

    #expect {
      try WindowMatching.match(tab: tab("https://a.test/", frame: CSSRect(left: 300, top: 100, width: 900, height: 700)), candidates: candidates)
    } throws: { error in
      guard case let .noMatch(text) = error as? WindowMatchError else { return false }
      return text.contains("not at tab 5's windowFrame")
    }
  }

  @Test func duplicateUrlWithoutFrameIsAmbiguous() {
    let candidates = [window(["https://a.test/"]), window(["https://a.test/"], at: CGRect(x: 50, y: 50, width: 10, height: 10))]

    #expect {
      try WindowMatching.match(tab: tab("https://a.test/"), candidates: candidates)
    } throws: { error in
      guard case let .ambiguous(text) = error as? WindowMatchError else { return false }
      return text.contains("2 Safari windows")
    }
  }

  @Test func equidistantFramesAreAmbiguous() {
    let candidates = [window(["https://a.test/"]), window(["https://a.test/"])]

    #expect(throws: WindowMatchError.self) { try WindowMatching.match(tab: tab("https://a.test/", frame: CSSRect(left: 0, top: 25, width: 1200, height: 800)), candidates: candidates) }
  }

  @Test func frameOutsideToleranceIsAmbiguous() {
    let candidates = [window(["https://a.test/"], at: CGRect(x: 0, y: 25, width: 1200, height: 800)), window(["https://a.test/"], at: CGRect(x: 300, y: 100, width: 900, height: 700))]

    #expect(throws: WindowMatchError.self) { try WindowMatching.match(tab: tab("https://a.test/", frame: CSSRect(left: 0, top: 500, width: 1200, height: 800)), candidates: candidates) }
  }

  @Test func noMatchListsWhatWasFound() {
    #expect {
      try WindowMatching.match(tab: tab("https://c.test/"), candidates: [window(["https://a.test/"])])
    } throws: { error in
      guard case let .noMatch(text) = error as? WindowMatchError else { return false }
      return text.contains("https://a.test/") && text.contains("tab 5")
    }
  }

  @Test func minimizedOrFramelessWindowIsUnreachable() {
    #expect(throws: WindowMatchError.unreachable("the window showing tab 5 is minimized: \(window(["https://a.test/"], minimized: true).summary)")) {
      try WindowMatching.match(tab: tab("https://a.test/"), candidates: [window(["https://a.test/"], minimized: true)])
    }

    #expect {
      try WindowMatching.match(tab: tab("https://a.test/"), candidates: [window(["https://a.test/"], at: nil)])
    } throws: { error in
      guard case .unreachable = error as? WindowMatchError else { return false }
      return true
    }
  }

  func titled(_ title: String, at frame: CGRect) -> WindowCandidate { WindowCandidate(title: title, frame: frame, minimized: false, urls: []) }

  @Test func byFrameFindsTheTabsWindowWithoutWebAreas() throws {
    let candidates = [titled("Other", at: CGRect(x: 0, y: 25, width: 1200, height: 800)), titled("Lab", at: CGRect(x: 100, y: 151, width: 1293, height: 1256))]
    #expect(try WindowMatching.byFrame(tab: tab("https://a.test/", frame: CSSRect(left: 100, top: 151, width: 1293, height: 1256)), candidates: candidates) == 1)
  }

  @Test func byFrameBreaksTiesByTitle() throws {
    let frame = CGRect(x: 0, y: 25, width: 1200, height: 800)
    let page = tab("https://a.test/", frame: CSSRect(left: 0, top: 25, width: 1200, height: 800))
    #expect(try WindowMatching.byFrame(tab: page, candidates: [titled("Mine", at: frame), titled("Page", at: frame)]) == 1)
    #expect(throws: WindowMatchError.self) { try WindowMatching.byFrame(tab: page, candidates: [titled("Page", at: frame), titled("Page", at: frame)]) }
    #expect(throws: WindowMatchError.self) { try WindowMatching.byFrame(tab: page, candidates: [titled("A", at: frame), titled("B", at: frame)]) }
  }

  @Test func byFrameNeedsAWindowFrameNearby() {
    let candidates = [titled("Page", at: CGRect(x: 0, y: 25, width: 1200, height: 800))]
    #expect(throws: WindowMatchError.self) { try WindowMatching.byFrame(tab: tab("https://a.test/"), candidates: candidates) }
    #expect(throws: WindowMatchError.self) { try WindowMatching.byFrame(tab: tab("https://a.test/", frame: CSSRect(left: 500, top: 25, width: 1200, height: 800)), candidates: candidates) }
  }

  @Test func distanceSumsEdgeOffsets() {
    #expect(WindowMatching.distance(CGRect(x: 10, y: 20, width: 100, height: 50), CSSRect(left: 12, top: 17, width: 100, height: 60)) == 15)
  }
}
