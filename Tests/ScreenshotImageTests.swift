import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

struct ScreenshotImageTests {
  /// A 200 x 100 PNG, red on the left half and blue on the right.
  let png = Self.image(200, 100)

  /// A width x height PNG, red on the left half and blue on the right.
  static func image(_ width: Int, _ height: Int) -> Data {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
    context.setFillColor(red: 0, green: 0, blue: 1, alpha: 1)
    context.fill(CGRect(x: width / 2, y: 0, width: width - width / 2, height: height))
    let data = NSMutableData()
    let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
    return data as Data
  }

  func size(_ data: Data) -> (Int, Int) {
    let image = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(data as CFData, nil)!, 0, nil)!
    return (image.width, image.height)
  }

  @Test func untouchedWithoutRegionOrScale() throws {
    let output = try ScreenshotImage.process(png, region: nil, scale: 1)
    #expect(output.png == png)
    #expect((output.width, output.height, output.frameWidth, output.frameHeight) == (200, 100, 200, 100))
  }

  @Test func cropsThenScales() throws {
    let output = try ScreenshotImage.process(png, region: PixelRect(x0: 20, y0: 10, x1: 120, y1: 90), scale: 0.5)
    #expect((output.width, output.height, output.frameWidth, output.frameHeight) == (50, 40, 200, 100))
    #expect(size(output.png) == (50, 40))
  }

  @Test func regionIsClippedToTheFrame() throws {
    let output = try ScreenshotImage.process(png, region: PixelRect(x0: 150, y0: 50, x1: 400, y1: 400), scale: 1)
    #expect((output.width, output.height) == (50, 50))
  }

  @Test func regionOutsideTheFrameFails() {
    #expect(throws: Failure.self) { try ScreenshotImage.process(png, region: PixelRect(x0: 300, y0: 0, x1: 400, y1: 50), scale: 1) }
  }

  @Test func fitsARetinaCaptureToTheBudget() throws {
    let output = try ScreenshotImage.process(Self.image(2880, 1800), region: nil, scale: 1)
    #expect((output.width, output.height) == (output.frameWidth, output.frameHeight))
    #expect(output.width <= 1568 && Double(output.width * output.height) <= AppCommand.screenshotMaxPixels)
    #expect(size(output.png) == (output.width, output.height))
  }

  @Test func capsTheLongEdge() throws {
    let output = try ScreenshotImage.process(Self.image(800, 4000), region: nil, scale: 1)
    #expect((output.width, output.height) == (313, 1568))
  }

  @Test func regionCropsTheNativeCapture() throws {
    let full = try ScreenshotImage.process(Self.image(3136, 1000), region: nil, scale: 1)
    #expect((full.frameWidth, full.frameHeight) == (1568, 500))
    let output = try ScreenshotImage.process(Self.image(3136, 1000), region: PixelRect(x0: 0, y0: 0, x1: 400, y1: 250), scale: 1)
    #expect((output.width, output.height, output.frameWidth, output.frameHeight) == (800, 500, 1568, 500))
  }
}
