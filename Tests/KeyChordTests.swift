import Testing

struct KeyChordTests {
  @Test func summaryCountsTypedCharactersAndNamesTheRest() throws {
    let chords = try ["h", "I", "Space", "Enter", "ctrl+a", "x", "shift+Tab"].map(KeyChord.parse)
    #expect(KeyChord.summary(chords) == "3 characters Enter ctrl+a 1 character shift+Tab")
    #expect(KeyChord.summary([]) == "")
  }

  @Test func typingMapsTextCharacters() throws {
    #expect(try KeyChord.typing("a") == KeyChord.parse("a"))
    #expect(try KeyChord.typing("Q") == KeyChord.parse("Q"))
    #expect(try KeyChord.typing(" ") == KeyChord.parse(" "))
    #expect(try KeyChord.typing("+") == KeyChord.parse("+"))
    #expect(try KeyChord.typing("\n") == KeyChord.parse("Enter"))
    #expect(try KeyChord.typing("\r\n") == KeyChord.parse("Enter"))
    #expect(try KeyChord.typing("\t") == KeyChord.parse("Tab"))

    for character: Character in ["\u{E9}", "\u{7}", "\u{1F600}"] {
      #expect(throws: Failure.self, "\(character)") { try KeyChord.typing(character) }
    }
  }

  @Test func namedKeysAreCaseInsensitive() throws {
    #expect(try KeyChord.parse("Enter") == KeyChord(key: "Enter", keyCode: 36, modifiers: [], character: nil))
    #expect(try KeyChord.parse("arrowup").keyCode == 126)
    #expect(try KeyChord.parse("Delete").keyCode == 117)
    #expect(try KeyChord.parse("Backspace").keyCode == 51)
    #expect(try KeyChord.parse("Space") == KeyChord(key: "Space", keyCode: 49, modifiers: [], character: " "))
  }

  @Test func modifierPrefixes() throws {
    #expect(try KeyChord.parse("cmd+a") == KeyChord(key: "a", keyCode: 0, modifiers: [.cmd], character: "a"))
    #expect(try KeyChord.parse("shift+Tab") == KeyChord(key: "Tab", keyCode: 48, modifiers: [.shift], character: nil))
    #expect(try KeyChord.parse("CTRL+alt+x").modifiers == [.ctrl, .alt])
    #expect(try KeyChord.parse("cmd+shift+z").name == "cmd+shift+z")
  }

  @Test func shiftedCharactersAddShiftOnce() throws {
    #expect(try KeyChord.parse("A") == KeyChord(key: "A", keyCode: 0, modifiers: [.shift], character: "A"))
    #expect(try KeyChord.parse("?") == KeyChord(key: "?", keyCode: 44, modifiers: [.shift], character: "?"))
    #expect(try KeyChord.parse("shift+A").modifiers == [.shift])
    #expect(try KeyChord.parse("cmd++") == KeyChord(key: "+", keyCode: 24, modifiers: [.cmd, .shift], character: "+"))
    #expect(try KeyChord.parse("+").keyCode == 24)
  }

  @Test func explicitShiftTypesTheShiftedCharacter() throws {
    #expect(try KeyChord.parse("shift+a") == KeyChord(key: "a", keyCode: 0, modifiers: [.shift], character: "A"))
    #expect(try KeyChord.parse("shift+1").character == "!")
    #expect(try KeyChord.parse("alt+a").character == "a")
  }

  @Test func unknownKeysFailWithTheAcceptedList() {
    for text in ["Return", "é", "cmd+", "cmd+cmd+a", "F1", ""] {
      #expect(throws: Failure.self, "\(text)") { try KeyChord.parse(text) }
    }

    #expect { try KeyChord.parse("Bogus") } throws: { ($0 as? Failure)?.description.contains("accepted keys: Enter, Tab") == true }
  }
}
