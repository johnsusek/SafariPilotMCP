import Testing

struct JSDialogTests {
  @Test func kindFollowsButtonsAndField() {
    #expect(JSDialog.kind(buttons: 1, textField: false) == .alert)
    #expect(JSDialog.kind(buttons: 2, textField: false) == .confirm)
    #expect(JSDialog.kind(buttons: 2, textField: true) == .prompt)
    #expect(JSDialog.kind(buttons: 3, textField: false) == nil)
    #expect(JSDialog.kind(buttons: 1, textField: true) == nil)
  }

  @Test func originComesFromBetweenTheCurlyQuotes() {
    #expect(JSDialog.origin(fromLine: "From \u{201C}http://127.0.0.1:8765\u{201D}:") == "http://127.0.0.1:8765")
    #expect(JSDialog.origin(fromLine: "no quotes") == "no quotes")
  }

  @Test func lineNamesKindOriginAndMessage() {
    #expect(JSDialog(kind: .confirm, message: "Sure?", origin: "https://a.test", promptText: nil).line == "a confirm from https://a.test: \"Sure?\"")
    #expect(JSDialog(kind: .alert, message: "", origin: "https://a.test", promptText: nil).line == "an alert from https://a.test: \"\"")
  }
}
