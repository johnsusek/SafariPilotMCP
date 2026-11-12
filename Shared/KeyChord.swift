/// One key press with modifiers, parsed from text like `Enter`, `cmd+a` or `shift+Tab`; key codes are macOS virtual key codes on the ANSI layout.
struct KeyChord: Codable, Sendable, Equatable {
  enum Modifier: String, Codable, Sendable, CaseIterable {
    case cmd, shift, alt, ctrl

    var keyCode: UInt16 {
      switch self {
      case .cmd: 55
      case .shift: 56
      case .alt: 58
      case .ctrl: 59
      }
    }
  }

  /// The canonical key name, or the character for printable keys.
  let key: String
  let keyCode: UInt16
  let modifiers: [Modifier]
  /// Set for printable keys so the posted event types this character whatever the keyboard layout.
  let character: String?

  var name: String { (modifiers.map(\.rawValue) + [key]).joined(separator: "+") }

  static let namedKeys: [(name: String, code: UInt16)] = [
    ("Enter", 36), ("Tab", 48), ("Space", 49), ("Backspace", 51), ("Escape", 53), ("Delete", 117),
    ("Home", 115), ("End", 119), ("PageUp", 116), ("PageDown", 121),
    ("ArrowLeft", 123), ("ArrowRight", 124), ("ArrowDown", 125), ("ArrowUp", 126),
  ]

  static let characterCodes: [Character: UInt16] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, " ": 49, "`": 50,
  ]

  /// Shifted ANSI characters mapped to the unshifted character on the same key.
  static let shiftedCharacters = Dictionary(uniqueKeysWithValues: zip("~!@#$%^&*()_+{}|:\"<>?", "`1234567890-=[]\\;',./"))

  static let accepted = "accepted keys: \(namedKeys.map(\.name).joined(separator: ", ")) or one printable ASCII character, optionally prefixed by cmd+, shift+, alt+ or ctrl+"

  static func parse(_ text: String) throws -> KeyChord {
    var rest = Substring(text)
    var modifiers: [Modifier] = []

    // A trailing "+" is the key itself, so "cmd++" is cmd plus the + key.
    while let modifier = Modifier.allCases.first(where: { rest.lowercased().hasPrefix("\($0.rawValue)+") && rest.count > $0.rawValue.count + 1 }) {
      guard !modifiers.contains(modifier) else { throw Failure(description: "modifier \(modifier.rawValue) repeated in \(text)") }

      modifiers.append(modifier)
      rest = rest.dropFirst(modifier.rawValue.count + 1)
    }

    if rest.count == 1, let character = rest.first {
      if let code = characterCodes[character] { return KeyChord(key: String(character), keyCode: code, modifiers: modifiers, character: String(character)) }

      let base = character.isASCII && character.isUppercase ? Character(character.lowercased()) : shiftedCharacters[character]

      if let base, let code = characterCodes[base] {
        let shifted = modifiers.contains(.shift) ? modifiers : modifiers + [.shift]
        return KeyChord(key: String(character), keyCode: code, modifiers: shifted, character: String(character))
      }
    }

    guard let named = namedKeys.first(where: { $0.name.lowercased() == rest.lowercased() }) else {
      throw Failure(description: "unknown key \"\(rest)\" in \(text); \(accepted)")
    }

    return KeyChord(key: named.name, keyCode: named.code, modifiers: modifiers, character: named.name == "Space" ? " " : nil)
  }
}
