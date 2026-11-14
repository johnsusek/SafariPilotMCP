import Foundation

/// wait for text or a selector, polled from the MCP server: each look is one short ordinary app command, and the sleeps between looks happen here, so the app's one-at-a-time queue is never held for a whole wait.
enum Wait {
  static let pollInterval = Duration.milliseconds(250)

  /// Looks until a match, a failed look (a dialog, a closed tab, a bad selector) or the timeout; a look the page could not answer yet, as mid-navigation, counts as not found.
  /// The last look starts at the deadline, so a page that shows the condition just in time still passes.
  static func poll(_ condition: WaitCondition, tabId: Int, timeout: Double, interval: Duration = pollInterval, look: (AppCommand) async throws -> CLIReply) async throws -> String {
    let start = ContinuousClock.now
    let deadline = start + .seconds(timeout)
    let waited = { String(format: "%.1f s", Double((ContinuousClock.now - start) / .milliseconds(1)) / 1000) }
    var looks = 0

    while true {
      let reply = try await look(.waitCheck(tabId: tabId, condition: condition))
      looks += 1

      guard reply.ok else { throw Failure(reply.code ?? .failed, "stopped waiting for \(condition.label) in tab \(tabId) after \(waited()): \(reply.text)") }

      if case .object = reply.data["match"] { return "\(reply.text)\nafter \(waited())" }

      let left = deadline - .now

      guard left > .zero else { throw Failure(.waitTimeout, "\(condition.label) did not appear in tab \(tabId) within \(timeout.formatted()) s (\(looks) looks); last look: \(reply.text)") }

      try await Task.sleep(for: min(interval, left))
    }
  }
}
