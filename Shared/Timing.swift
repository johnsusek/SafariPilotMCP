import Foundation
import Synchronization

/// How long one phase of a command took; phases of one name add up, and count says how many there were.
struct TimedPhase: Codable, Sendable, Equatable {
  let name: String
  var ms: Double
  var count = 1
}

/// A command's whole run in the app and its phases in the order each first ran.
struct CommandTiming: Codable, Sendable, Equatable {
  let totalMs: Double
  let phases: [TimedPhase]

  /// `412 ms: queue 0, tab 9, events 2x 31, ...`, phases in the order they first ran.
  var line: String {
    let shown = phases.map { "\($0.name) \($0.count > 1 ? "\($0.count)x " : "")\(Int($0.ms.rounded()))" }
    let total = "\(Int(totalMs.rounded())) ms"
    return shown.isEmpty ? total : "\(total): \(shown.joined(separator: ", "))"
  }
}

/// Collects the phases of the command running in the current task: queue wait, extension round trips, AX work, input, sleeps, settle and the diff's quiet wait.
/// It rides in a task local, so the app's command code, Commands and AXEngine record into it without passing it along.
final class Timing: Sendable {
  @TaskLocal static var current: Timing?

  private let start = ContinuousClock.now
  private let recorded = Mutex<[TimedPhase]>([])

  func add(_ name: String, _ duration: Duration) {
    let ms = Double(duration / .microseconds(1)) / 1000

    recorded.withLock { phases in
      guard let index = phases.firstIndex(where: { $0.name == name }) else {
        phases.append(TimedPhase(name: name, ms: ms))
        return
      }

      phases[index].ms += ms
      phases[index].count += 1
    }
  }

  var finished: CommandTiming { CommandTiming(totalMs: Double((.now - start) / .microseconds(1)) / 1000, phases: recorded.withLock { $0 }) }

  /// Records how long work took under name, thrown or not, in the current command's timing.
  static func measure<Value>(_ name: String, isolation: isolated (any Actor)? = #isolation, _ work: () async throws -> Value) async rethrows -> Value {
    let start = ContinuousClock.now
    defer { current?.add(name, .now - start) }
    return try await work()
  }

  static func sleep(for duration: Duration, isolation: isolated (any Actor)? = #isolation) async throws {
    try await measure("sleep") { try await Task.sleep(for: duration) }
  }
}
