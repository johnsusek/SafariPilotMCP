import CoreGraphics

/// Scores AX frames against an element's mapped screen rect, so elements are resolved by their reported frames instead of by hit test.
enum FrameMatching {
  /// Scores within this of each other count as a tie, which the deeper element wins.
  static let tie = 0.02

  /// Below this the best frame is too far from the element to act on.
  static let minimum = 0.7

  /// Both rects grow by this many points before scoring, since AX frames are rounded to whole points, which alone halves the score of a 1 px wide element (Monaco's hidden textarea).
  static let slack: CGFloat = 2

  /// Intersection over union of the rects grown by slack: 1 for identical rects, 0 for ones further apart than twice slack.
  static func score(_ frame: CGRect, _ wanted: CGRect) -> Double {
    let frame = frame.insetBy(dx: -slack, dy: -slack)
    let wanted = wanted.insetBy(dx: -slack, dy: -slack)
    let overlap = frame.intersection(wanted)

    if overlap.isNull || overlap.isEmpty { return 0 }

    let shared = overlap.width * overlap.height
    return shared / (frame.width * frame.height + wanted.width * wanted.height - shared)
  }

  /// Whether a candidate beats the current best: clearly higher, or tied and deeper (a wrapper and its sole child often share a frame).
  static func beats(score: Double, depth: Int, best: (score: Double, depth: Int)?) -> Bool {
    guard let best else { return true }

    if score > best.score + tie { return true }

    return score >= best.score - tie && depth > best.depth
  }

  struct Found<Node> {
    let lineage: [Node]
    let score: Double
  }

  /// The node under roots whose frame best matches wanted, with its lineage from it up to, not including, the roots' parent. With prune, subtrees whose non-empty frame misses wanted are skipped; empty or missing frames are still entered, since their children can lie outside them, and so are nested web areas, whose frame can be their document's size rather than their iframe's box.
  static func best<Node>(under roots: [Node], for wanted: CGRect, prune: Bool, limit: Int, children: (Node) -> [Node], frame: (Node) -> CGRect?, role: (Node) -> String) throws -> (best: Found<Node>?, visited: Int) {
    var best: Found<Node>?
    var frontier: [[Node]] = roots.map { [$0] }
    var visited = 0

    while let lineage = frontier.popLast() {
      visited += 1

      guard visited <= limit else { throw Failure(.notActionable, "visited \(limit) AX elements under the web area without finishing; page is too large to resolve by frame") }

      let node = lineage[0]
      let nodeFrame = frame(node)

      if prune, let nodeFrame, !nodeFrame.isEmpty, !nodeFrame.intersects(wanted), role(node) != "AXWebArea" { continue }

      if let nodeFrame {
        let score = score(nodeFrame, wanted)

        if beats(score: score, depth: lineage.count, best: best.map { ($0.score, $0.lineage.count) }) { best = Found(lineage: lineage, score: score) }
      }

      frontier.append(contentsOf: children(node).reversed().map { [$0] + lineage })
    }

    return (best, visited)
  }
}
