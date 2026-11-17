import CoreGraphics
import Testing

struct FrameMatchingTests {
  let wanted = CGRect(x: 100, y: 200, width: 80, height: 20)

  @Test func identicalFramesScoreOne() { #expect(FrameMatching.score(wanted, wanted) == 1) }

  @Test func distantFramesScoreZeroAndTouchingOnesNearly() {
    #expect(FrameMatching.score(CGRect(x: 500, y: 500, width: 10, height: 10), wanted) == 0)
    #expect(FrameMatching.score(CGRect(x: 180, y: 200, width: 10, height: 20), wanted) < 0.05)
  }

  @Test func containingWrapperScoresByAreaRatio() {
    let wrapper = CGRect(x: 100, y: 200, width: 160, height: 20)
    #expect(abs(FrameMatching.score(wrapper, wanted) - 0.5) < 0.03)
  }

  @Test func onePointWideElementMatchesItsRoundedFrame() {
    #expect(FrameMatching.score(CGRect(x: 478, y: 291, width: 2, height: 19), CGRect(x: 478, y: 291.4, width: 1, height: 18)) >= FrameMatching.minimum)
  }

  @Test func clearlyHigherScoreWinsRegardlessOfDepth() {
    #expect(FrameMatching.beats(score: 0.95, depth: 1, best: (0.6, 5)))
    #expect(!FrameMatching.beats(score: 0.6, depth: 5, best: (0.95, 1)))
  }

  @Test func tiedScoreGoesToTheDeeperElement() {
    #expect(FrameMatching.beats(score: 0.99, depth: 4, best: (1, 3)))
    #expect(!FrameMatching.beats(score: 1, depth: 3, best: (0.99, 4)))
    #expect(!FrameMatching.beats(score: 1, depth: 3, best: (1, 3)))
  }

  @Test func firstCandidateAlwaysWins() { #expect(FrameMatching.beats(score: 0, depth: 1, best: nil)) }

  struct Node {
    let role: String
    let frame: CGRect?
    var children: [Node] = []
  }

  func best(_ roots: [Node], prune: Bool) throws -> FrameMatching.Found<Node>? {
    try FrameMatching.best(under: roots, for: wanted, prune: prune, limit: 100, children: \.children, frame: \.frame, role: \.role).best
  }

  /// A nested web area can report its document's size, away from its iframe's box, while its elements sit where they are drawn.
  @Test func pruningStillEntersNestedWebAreas() throws {
    let button = Node(role: "AXButton", frame: wanted)
    let frameDocument = Node(role: "AXWebArea", frame: CGRect(x: 0, y: 0, width: 50, height: 50), children: [Node(role: "AXGroup", frame: nil, children: [button])])
    let found = try best([Node(role: "AXGroup", frame: CGRect(x: 0, y: 0, width: 400, height: 400), children: [frameDocument])], prune: true)
    #expect(found?.score == 1)
    #expect(found?.lineage.map(\.role) == ["AXButton", "AXGroup", "AXWebArea", "AXGroup"])
    let group = Node(role: "AXGroup", frame: CGRect(x: 0, y: 0, width: 50, height: 50), children: [button])
    #expect(try best([group], prune: true) == nil)
  }

  @Test func walkStopsAtTheLimit() {
    let wide = Node(role: "AXGroup", frame: nil, children: Array(repeating: Node(role: "AXGroup", frame: nil), count: 200))
    #expect(throws: Failure.self) { try best([wide], prune: false) }
  }

  @Test func focusInsideAFrameOfThePageCounts() {
    let page = CGRect(x: 0, y: 100, width: 1000, height: 700)
    let inFrame: [(role: String, frame: CGRect?)] = [("AXTextField", CGRect(x: 50, y: 300, width: 100, height: 20)), ("AXWebArea", CGRect(x: 40, y: 290, width: 343, height: 195))]
    #expect(KeyboardFocus.inFrameOfPage(sameWindow: true, ancestors: inFrame, webArea: page))
    #expect(!KeyboardFocus.inFrameOfPage(sameWindow: false, ancestors: inFrame, webArea: page))
    #expect(!KeyboardFocus.inFrameOfPage(sameWindow: true, ancestors: [("AXTextField", CGRect(x: 50, y: 10, width: 100, height: 20)), ("AXWebArea", CGRect(x: 0, y: 0, width: 300, height: 40))], webArea: page))
    #expect(!KeyboardFocus.inFrameOfPage(sameWindow: true, ancestors: [("AXTextField", nil), ("AXGroup", page)], webArea: page))
  }
}
