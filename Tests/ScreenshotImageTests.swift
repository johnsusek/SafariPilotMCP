import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

struct ScreenshotImageTests {
  /// A 200 x 100 PNG, red on the left half and blue on the right.
  let png: Data = {
    let context = CGContext(data: nil, width: 200, height: 100, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
    context.setFillColor(red: 0, green: 0, blue: 1, alpha: 1)
    context.fill(CGRect(x: 100, y: 0, width: 100, height: 100))
    let data = NSMutableData()
    let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
    return data as Data
  }()

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
}
