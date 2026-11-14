import CoreGraphics

/// The room a window has on its screen. Screens are AppKit frames (bottom-left origin, y up) with the primary screen first; the window frame comes from the extension (top-left origin of the primary screen, y down).
enum ScreenFit {
  typealias Screen = (frame: CGRect, visible: CGRect)

  /// The visible frame of the screen holding the window's center, else of the primary screen.
  static func room(for window: CSSRect?, screens: [Screen]) throws -> CGRect {
    guard let primary = screens.first else { throw Failure(.failed, "no screens attached") }
    guard let window else { return primary.visible }

    let center = CGPoint(x: window.left + window.width / 2, y: primary.frame.maxY - (window.top + window.height / 2))
    return (screens.first { $0.frame.contains(center) } ?? primary).visible
  }
}
