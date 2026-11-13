/// A JavaScript alert, confirm or prompt as Safari 27 shows it in place of a tab's page: an AXGroup/AXDialog holding a "From “origin”:" line, the message, its buttons and, for a prompt, a text field.
struct JSDialog: Codable, Sendable, Equatable {
  enum Kind: String, Codable, Sendable {
    case alert, confirm, prompt
  }

  let kind: Kind
  let message: String
  let origin: String
  /// A prompt's current text.
  let promptText: String?

  /// An alert has one button (Close), a confirm two (Cancel, OK), and a prompt the same two plus a text field.
  static func kind(buttons: Int, textField: Bool) -> Kind? {
    switch (buttons, textField) {
    case (1, false): .alert
    case (2, false): .confirm
    case (2, true): .prompt
    default: nil
    }
  }

  /// The origin between the curly quotes of Safari's "From “http://example.com”:" line, else the whole line.
  static func origin(fromLine line: String) -> String {
    guard let open = line.firstIndex(of: "\u{201C}"), let close = line.lastIndex(of: "\u{201D}"), open < close else { return line }
    return String(line[line.index(after: open) ..< close])
  }

  var line: String { "\(kind == .alert ? "an" : "a") \(kind.rawValue) from \(origin): \"\(message)\"" }
}
