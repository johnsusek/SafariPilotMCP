import CoreGraphics

enum KeyboardFocus {
  /// For focus whose ancestor chain does not reach the page's web area: it still counts as in the page when it is in the same window and inside a frame's AXWebArea that starts within the page's web area, in case WebKit leaves a frame's parent link out. A nested web area's frame can be its document's size, so only its origin is compared.
  static func inFrameOfPage(sameWindow: Bool, ancestors: [(role: String, frame: CGRect?)], webArea: CGRect?) -> Bool {
    guard sameWindow, let webArea else { return false }

    return ancestors.contains { $0.role == "AXWebArea" && $0.frame.map { webArea.contains($0.origin) } == true }
  }
}
