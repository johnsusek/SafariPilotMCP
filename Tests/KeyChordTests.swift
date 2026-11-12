import Testing

struct KeyChordTests {
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

  @Test func unknownKeysFailWithTheAcceptedList() {
    for text in ["Return", "é", "cmd+", "cmd+cmd+a", "F1", ""] {
      #expect(throws: Failure.self, "\(text)") { try KeyChord.parse(text) }
    }

    #expect { try KeyChord.parse("Bogus") } throws: { ($0 as? Failure)?.description.contains("accepted keys: Enter, Tab") == true }
  }
}
