import Foundation
import Testing

/// Wait.poll against a fake app: each look returns the next scripted reply, the last one repeating.
struct WaitTests {
  let pending = CLIReply(ok: true, text: "the page cannot be read yet: no content script answered in tab 4", data: .object(["match": .null, "pending": "no content script answered in tab 4"]))
  let missing = CLIReply(ok: true, text: "no text \"Ready\" on https://a.test/ yet", data: .object(["match": .null, "pending": .null]))
  let found = CLIReply(ok: true, text: "found text \"Ready\" at [5:12] paragraph <p> \"Ready now\"", data: .object(["match": .object(["ref": "5:12"]), "pending": .null]))
  let dialog = CLIReply(ok: false, text: "tab 4 shows an alert \"Saved\"; Safari's extension, and so every page tool, waits until handle_dialog accepts or dismisses it", data: .object(["error": "dialog"]), code: .dialogOpen)

  final class Script: @unchecked Sendable {
    var replies: [CLIReply]
    var looks: [AppCommand] = []

    init(_ replies: [CLIReply]) { self.replies = replies }

    func look(_ command: AppCommand) async throws -> CLIReply {
      looks.append(command)
      return replies.count > 1 ? replies.removeFirst() : replies[0]
    }
  }

  func poll(_ script: Script, timeout: Double) async throws -> String {
    try await Wait.poll(.text("Ready"), tabId: 4, timeout: timeout, interval: .milliseconds(5), look: script.look)
  }

  @Test func looksThroughAnUnreadablePageUntilTheTextAppears() async throws {
    let script = Script([pending, pending, missing, found])
    let result = try await poll(script, timeout: 5)
    #expect(result.hasPrefix("found text \"Ready\" at [5:12] paragraph <p> \"Ready now\"\nafter "))
    #expect(script.looks == Array(repeating: .waitCheck(tabId: 4, condition: .text("Ready")), count: 4))
  }

  @Test func timesOutNamingWhatItWaitedForAndHowLong() async throws {
    let script = Script([missing])
    let started = ContinuousClock.now

    await #expect {
      try await poll(script, timeout: 0.05)
    } throws: { error in
      let text = (error as? Failure)?.description ?? ""
      return (error as? Failure)?.code == .waitTimeout && text.hasPrefix("text \"Ready\" did not appear in tab 4 within 0.05 s (") && text.hasSuffix("last look: no text \"Ready\" on https://a.test/ yet")
    }

    #expect(ContinuousClock.now - started >= .milliseconds(50))
    #expect(script.looks.count >= 2)
  }

  @Test func aDialogStopsTheWaitAtOnce() async throws {
    let script = Script([missing, dialog])

    await #expect {
      try await poll(script, timeout: 10)
    } throws: { error in
      (error as? Failure)?.code == .dialogOpen && (error as? Failure)?.description.hasPrefix("stopped waiting for text \"Ready\" in tab 4 after ") == true && (error as? Failure)?.description.hasSuffix(": \(dialog.text)") == true
    }

    #expect(script.looks.count == 2)
  }

  @Test func aSiteSafariHasNotGrantedStopsTheWaitAtOnce() async throws {
    let access = Failure(.siteAccessPrompt, "Safari is asking the user whether SafariPilot may use https://a.test and holds every call for tab 4 until they answer.")
    let script = Script([pending, CLIReply(failed: access), found])

    await #expect {
      try await poll(script, timeout: 10)
    } throws: { error in
      (error as? Failure)?.code == .siteAccessPrompt && (error as? Failure)?.description.hasSuffix(": \(access.description)") == true
    }

    #expect(script.looks.count == 2)
  }

  @Test func aZeroTimeoutLooksOnce() async throws {
    let script = Script([missing, found])
    await #expect(throws: Failure.self) { try await poll(script, timeout: 0) }
    #expect(script.looks.count == 1)
    #expect(try await poll(Script([found]), timeout: 0).hasPrefix("found"))
  }
}
