import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Crops a PNG to a region of its pixels and shrinks it by scale, returning the new PNG with its size and the original's.
enum ScreenshotImage {
  struct Output: Equatable {
    let png: Data
    let width: Int
    let height: Int
    let frameWidth: Int
    let frameHeight: Int
  }

  static func process(_ png: Data, region: PixelRect?, scale: Double) throws -> Output {
    guard let source = CGImageSourceCreateWithData(png as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw Failure(description: "screenshot is not a decodable PNG") }

    let frame = CGRect(x: 0, y: 0, width: image.width, height: image.height)

    guard region != nil || scale != 1 else { return Output(png: png, width: image.width, height: image.height, frameWidth: image.width, frameHeight: image.height) }

    var cropped = image

    if let region {
      let rect = CGRect(x: region.x0, y: region.y0, width: region.x1 - region.x0, height: region.y1 - region.y0).intersection(frame)

      guard !rect.isEmpty, let crop = image.cropping(to: rect) else { throw Failure(description: "region \([region.x0, region.y0, region.x1, region.y1]) lies outside the \(image.width) x \(image.height) px screenshot") }

      cropped = crop
    }

    let width = max(1, Int((Double(cropped.width) * scale).rounded()))
    let height = max(1, Int((Double(cropped.height) * scale).rounded()))
    let space = CGColorSpace(name: CGColorSpace.sRGB)!

    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw Failure(description: "could not create a \(width) x \(height) image context") }

    context.interpolationQuality = .high
    context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))

    let data = NSMutableData()

    guard let result = context.makeImage(), let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw Failure(description: "could not encode the screenshot") }

    CGImageDestinationAddImage(destination, result, nil)

    guard CGImageDestinationFinalize(destination) else { throw Failure(description: "could not encode the screenshot") }

    return Output(png: data as Data, width: width, height: height, frameWidth: image.width, frameHeight: image.height)
  }
}
