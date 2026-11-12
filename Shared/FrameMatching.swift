import CoreGraphics

/// Scores AX frames against an element's mapped screen rect, so elements are resolved by their reported frames instead of by hit test.
enum FrameMatching {
  /// Scores within this of each other count as a tie, which the deeper element wins.
  static let tie = 0.02

  /// Below this the best frame is too far from the element to act on.
  static let minimum = 0.7

  /// Intersection over union: 1 for identical rects, 0 for disjoint ones.
  static func score(_ frame: CGRect, _ wanted: CGRect) -> Double {
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
}
