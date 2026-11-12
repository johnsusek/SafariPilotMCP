import CoreGraphics

/// Mirror of `Viewport` in web/src/shared/protocol.ts.
struct Viewport: Codable, Sendable, Equatable {
  var innerWidth: Double
  var innerHeight: Double
  var scrollX: Double
  var scrollY: Double
  var devicePixelRatio: Double
  var visualScale: Double
  var visualOffsetLeft: Double
  var visualOffsetTop: Double
  var visualWidth: Double?
  var visualHeight: Double?
  var clientWidth: Double?
  var clientHeight: Double?
}

/// Maps CSS px in the layout viewport to AX screen points (top-left origin, y down).
enum ViewportMapping {
  /// The AXWebArea frame can span the whole document, so the enclosing AXScrollArea is the visible viewport when present.
  static func viewportFrame(webArea: CGRect, scrollArea: CGRect?) -> CGRect { scrollArea ?? webArea }

  /// Points per CSS px at pinch scale 1; covers page zoom (Cmd +/-), which shrinks innerWidth.
  static func zoom(viewport: Viewport, frame: CGRect) -> Double { frame.width / viewport.innerWidth }

  /// Alternative scale (points per CSS px, pinch included) that holds even if WebKit reports a pinch-zoomed innerWidth; debug-ax prints both.
  static func visualZoom(viewport: Viewport, frame: CGRect) -> Double? { viewport.visualWidth.map { frame.width / $0 } }

  /// Pinch zoom shows the layout viewport region starting at the visual offset, magnified by visualScale.
  static func screenPoint(css point: CGPoint, viewport: Viewport, frame: CGRect) -> CGPoint {
    let scale = zoom(viewport: viewport, frame: frame) * viewport.visualScale
    return CGPoint(
      x: frame.minX + (point.x - viewport.visualOffsetLeft) * scale,
      y: frame.minY + (point.y - viewport.visualOffsetTop) * scale
    )
  }

  static func screenRect(css rect: CSSRect, viewport: Viewport, frame: CGRect) -> CGRect {
    let scale = zoom(viewport: viewport, frame: frame) * viewport.visualScale
    let origin = screenPoint(css: CGPoint(x: rect.left, y: rect.top), viewport: viewport, frame: frame)
    return CGRect(x: origin.x, y: origin.y, width: rect.width * scale, height: rect.height * scale)
  }
}
