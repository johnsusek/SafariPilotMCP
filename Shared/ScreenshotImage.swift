import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Fits a capture to the image budget every Claude model takes without resizing; region is in the fitted frame's pixels and crops the native capture, so a zoom keeps detail.
enum ScreenshotImage {
  struct Output: Equatable {
    let png: Data
    let width: Int
    let height: Int
    let frameWidth: Int
    let frameHeight: Int
  }

  /// The factor, at most 1, that brings width x height within the screenshot limits.
  static func fit(_ width: Int, _ height: Int) -> Double {
    min(1, AppCommand.screenshotMaxEdge / Double(max(width, height)), (AppCommand.screenshotMaxPixels / Double(width * height)).squareRoot())
  }

  static func process(_ png: Data, region: PixelRect?, scale: Double) throws -> Output {
    guard let source = CGImageSourceCreateWithData(png as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw Failure(.failed, "screenshot is not a decodable PNG") }

    let frameFit = fit(image.width, image.height)
    let frameWidth = max(1, Int((Double(image.width) * frameFit).rounded(.down)))
    let frameHeight = max(1, Int((Double(image.height) * frameFit).rounded(.down)))

    guard region != nil || frameFit * scale != 1 else { return Output(png: png, width: image.width, height: image.height, frameWidth: frameWidth, frameHeight: frameHeight) }

    var cropped = image

    if let region {
      let native = CGRect(x: Double(region.x0) / frameFit, y: Double(region.y0) / frameFit, width: Double(region.x1 - region.x0) / frameFit, height: Double(region.y1 - region.y0) / frameFit)
      let rect = native.integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))

      guard !rect.isEmpty, let crop = image.cropping(to: rect) else { throw Failure(.invalidArgument, "region \([region.x0, region.y0, region.x1, region.y1]) lies outside the \(frameWidth) x \(frameHeight) px screenshot") }

      cropped = crop
    }

    let factor = fit(cropped.width, cropped.height) * scale
    let width = max(1, Int((Double(cropped.width) * factor).rounded(.down)))
    let height = max(1, Int((Double(cropped.height) * factor).rounded(.down)))
    let space = CGColorSpace(name: CGColorSpace.sRGB)!

    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw Failure(.failed, "could not create a \(width) x \(height) image context") }

    context.interpolationQuality = .high
    context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))

    let data = NSMutableData()

    guard let result = context.makeImage(), let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw Failure(.failed, "could not encode the screenshot") }

    CGImageDestinationAddImage(destination, result, nil)

    guard CGImageDestinationFinalize(destination) else { throw Failure(.failed, "could not encode the screenshot") }

    return Output(png: data as Data, width: width, height: height, frameWidth: frameWidth, frameHeight: frameHeight)
  }
}
