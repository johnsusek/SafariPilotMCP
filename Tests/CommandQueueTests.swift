import Testing

@MainActor
struct CommandQueueTests {
  final class Log {
    var entries: [String] = []
  }

  @Test func runsOneAtATimeInArrivalOrder() async {
    let queue = CommandQueue()
    let log = Log()
    let tasks = ["first", "second", "third"].map { name in
      Task { @MainActor in
        await queue.run {
          log.entries.append("\(name) starts")
          try? await Task.sleep(for: .milliseconds(20))
          log.entries.append("\(name) ends")
        }
      }
    }

    for task in tasks { await task.value }

    #expect(log.entries == ["first starts", "first ends", "second starts", "second ends", "third starts", "third ends"])
  }

  @Test func aThrowingCommandGivesUpItsTurn() async throws {
    let queue = CommandQueue()

    await #expect(throws: Failure.self) { try await queue.run { throw Failure(description: "failed") } }
    #expect(await queue.run { 5 } == 5)
  }
}
