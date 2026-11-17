import CoreGraphics
import Foundation
import Testing

struct ViewportMappingTests {
  let viewport = Viewport(innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 340, devicePixelRatio: 2, visualScale: 1, visualOffsetLeft: 0, visualOffsetTop: 0)
  let frame = CGRect(x: 100, y: 152, width: 1200, height: 800)

  @Test func unzoomedPointOffsetsByFrameOrigin() {
    let point = ViewportMapping.screenPoint(css: CGPoint(x: 10, y: 20), viewport: viewport, frame: frame)
    #expect(point == CGPoint(x: 110, y: 172))
  }

  @Test func scrollDoesNotMoveViewportRelativePoints() {
    var scrolled = viewport
    scrolled.scrollY = 9000
    #expect(ViewportMapping.screenPoint(css: CGPoint(x: 10, y: 20), viewport: scrolled, frame: frame) == CGPoint(x: 110, y: 172))
  }

  @Test func pageZoomScalesByFrameWidthOverInnerWidth() {
    var zoomed = viewport
    zoomed.innerWidth = 960
    #expect(ViewportMapping.zoom(viewport: zoomed, frame: frame) == 1.25)
    #expect(ViewportMapping.screenPoint(css: CGPoint(x: 100, y: 40), viewport: zoomed, frame: frame) == CGPoint(x: 225, y: 202))
  }

  @Test func pinchZoomSubtractsVisualOffsetThenMagnifies() {
    var pinched = viewport
    pinched.visualScale = 2
    pinched.visualOffsetLeft = 300
    pinched.visualOffsetTop = 200
    #expect(ViewportMapping.screenPoint(css: CGPoint(x: 310, y: 205), viewport: pinched, frame: frame) == CGPoint(x: 120, y: 162))
  }

  @Test func rectMapsOriginAndScalesSizeWithZoomAndPinch() {
    var zoomed = viewport
    zoomed.innerWidth = 960
    zoomed.visualScale = 2
    zoomed.visualOffsetLeft = 50
    let rect = CSSRect(left: 100, top: 40, width: 30, height: 10)
    #expect(ViewportMapping.screenRect(css: rect, viewport: zoomed, frame: frame) == CGRect(x: 225, y: 252, width: 75, height: 25))
  }

  @Test func visualZoomUsesVisibleWidthIncludingPinch() {
    var pinched = viewport
    pinched.visualScale = 2
    pinched.visualWidth = 600
    #expect(ViewportMapping.visualZoom(viewport: pinched, frame: frame) == 2)
    #expect(ViewportMapping.visualZoom(viewport: viewport, frame: frame) == nil)
  }

  @Test func locateViewportDecodesWithOptionalFields() throws {
    let json = #"{"innerWidth":1200,"innerHeight":800,"scrollX":0,"scrollY":0,"devicePixelRatio":2,"visualScale":1,"visualOffsetLeft":0,"visualOffsetTop":0,"visualWidth":1185}"#
    let decoded = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)).decode(Viewport.self)
    #expect(decoded.visualWidth == 1185)
    #expect(decoded.clientWidth == nil)
  }

  @Test func scrollAreaWinsOverDocumentSizedWebArea() {
    let webArea = CGRect(x: 100, y: -188, width: 1200, height: 5000)
    #expect(ViewportMapping.viewportFrame(webArea: webArea, scrollArea: frame) == frame)
    #expect(ViewportMapping.viewportFrame(webArea: webArea, scrollArea: nil) == webArea)
  }

  @Test func centerOnAnEdgeDoesNotLand() {
    let option = CGRect(x: 1202, y: 238, width: 197, height: 24)
    #expect(!ViewportMapping.centerLands(CGRect(x: 1200, y: 237, width: 200, height: 50), in: option))
    #expect(!ViewportMapping.centerLands(CGRect(x: 1200, y: 300, width: 200, height: 300), in: option))
    #expect(ViewportMapping.centerLands(CGRect(x: 1190, y: 230, width: 220, height: 40), in: option))
  }
}
