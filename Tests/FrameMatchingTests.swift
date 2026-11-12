import CoreGraphics
import Testing

struct FrameMatchingTests {
  let wanted = CGRect(x: 100, y: 200, width: 80, height: 20)

  @Test func identicalFramesScoreOne() { #expect(FrameMatching.score(wanted, wanted) == 1) }

  @Test func disjointAndTouchingFramesScoreZero() {
    #expect(FrameMatching.score(CGRect(x: 500, y: 500, width: 10, height: 10), wanted) == 0)
    #expect(FrameMatching.score(CGRect(x: 180, y: 200, width: 10, height: 20), wanted) == 0)
  }

  @Test func containingWrapperScoresByAreaRatio() {
    let wrapper = CGRect(x: 100, y: 200, width: 160, height: 20)
    #expect(FrameMatching.score(wrapper, wanted) == 0.5)
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
}
