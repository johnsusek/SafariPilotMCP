/// Runs one command at a time, in arrival order. A click, typed text or key press depends on which tab its window shows and on where
/// Safari's keyboard focus is, and another client's command running between its steps would move both.
@MainActor
final class CommandQueue {
  private var running = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  func run<Value>(_ work: @MainActor () async throws -> Value) async rethrows -> Value {
    if running { await withCheckedContinuation { waiting.append($0) } }

    running = true
    // The turn passes straight to the first waiter, so running stays true and a command arriving meanwhile cannot jump the line.
    defer {
      if waiting.isEmpty { running = false } else { waiting.removeFirst().resume() }
    }
    return try await work()
  }
}
