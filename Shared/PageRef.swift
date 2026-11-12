/// An element ref anywhere in the page: the refs of the iframes leading to its frame, then its ref inside that frame.
/// "12" is a top-frame ref and "5:12" is ref 12 in the frame of iframe 5. Decodes from a number or a string; encodes as a string.
struct PageRef: Codable, Hashable, Sendable, CustomStringConvertible, ExpressibleByIntegerLiteral {
  let frames: [Int]
  let local: Int

  static let maxFrames = 3

  init(frames: [Int] = [], local: Int) {
    self.frames = frames
    self.local = local
  }

  init(integerLiteral value: Int) { self.init(local: value) }

  init(parsing text: String) throws {
    guard text.wholeMatch(of: /\d{1,9}(:\d{1,9}){0,3}/) != nil else {
      let hint = text.contains(".") ? "; refs inside frames are strings like \"5:12\", not 5.12" : ""
      throw Failure(description: "ref \"\(text)\" must look like 12, or 5:12 for ref 12 inside the frame of iframe 5, at most \(Self.maxFrames) frames deep\(hint)")
    }

    let parts = text.split(separator: ":").map { Int($0)! }
    self.init(frames: Array(parts.dropLast()), local: parts.last!)
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()

    if let local = try? container.decode(Int.self) {
      self.init(local: local)
      return
    }

    try self.init(parsing: container.decode(String.self))
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(description)
  }

  var description: String { (frames + [local]).map(String.init).joined(separator: ":") }

  /// The path of the frame that owns the element, "" for the top frame; events name their frame the same way.
  var frame: String { frames.map(String.init).joined(separator: ":") }
}
