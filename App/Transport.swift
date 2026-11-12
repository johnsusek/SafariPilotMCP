import Foundation
import Observation
import SafariServices

/// App side of the long-poll push transport. The background keeps one sendNativeMessage poll open;
/// the app answers it with the next command, or with `command: null` after `pollHold`.
@Observable @MainActor
final class Transport {
  struct Instance: Identifiable {
    let id: String
    let startedAt: Date
    let firstSeen: Date
    var lastSeen: Date
    var polls = 0
  }

  struct LifecycleEntry: Identifiable {
    let id = UUID()
    let instance: String
    let event: String
    let at: Date
  }

  private struct OpenPoll {
    let instance: String
    let openedAt: Date
    let continuation: CheckedContinuation<JSONValue, Never>
  }

  static let extensionId = "net.johnsolo.SafariPilot.Extension"
  static let pollHold: Duration = .seconds(20)

  private(set) var instances: [String: Instance] = [:]
  private(set) var lifecycle: [LifecycleEntry] = []
  private(set) var lastSeen: Date?
  private(set) var lastDispatch: String?
  private(set) var listening = false
  private(set) var listenError: String?
  private var openPolls: [UUID: OpenPoll] = [:]
  private var queue: [JSONValue] = []
  private var pending: [String: CheckedContinuation<JSONValue, any Error>] = [:]

  var openPollCount: Int { openPolls.count }
  var oldestOpenPoll: Date? { openPolls.values.map(\.openedAt).min() }

  func setListening(_ listening: Bool, error: String? = nil) {
    self.listening = listening
    listenError = error
  }

  func handle(_ message: JSONValue) async -> JSONValue {
    guard let instanceId = message["instance"]?["id"]?.string else { return .object(["error": .string("message without instance")]) }

    touch(instanceId, startedAt: message["instance"]?["startedAt"]?.number)

    switch message["kind"]?.string {
    case "poll":
      // The previous command's result rides on the next poll.
      if let result = message["result"], let id = result["id"]?.string {
        pending.removeValue(forKey: id)?.resume(returning: result["response"] ?? .null)
      }

      return await poll(instanceId)
    case "lifecycle":
      let at = message["at"]?.number.map { Date(timeIntervalSince1970: $0 / 1000) } ?? .now
      record(instanceId, event: message["event"]?.string ?? "?", at: at)
      return .object(["ok": .bool(true)])
    case "keepalive":
      return .object(["ok": .bool(true)])
    default:
      return .object(["error": .string("unknown kind")])
    }
  }

  /// Sends a command to the background and waits for its response.
  func send(_ command: [String: JSONValue], timeout: Duration) async throws -> JSONValue {
    let id = UUID().uuidString
    var command = command
    command["id"] = .string(id)
    let envelope = JSONValue.object(command)

    return try await withCheckedThrowingContinuation { continuation in
      pending[id] = continuation

      if let (key, poll) = openPolls.max(by: { $0.value.openedAt < $1.value.openedAt }) {
        openPolls.removeValue(forKey: key)
        poll.continuation.resume(returning: .object(["command": envelope]))
      } else {
        queue.append(envelope)
        nudge()
      }

      Task {
        try? await Task.sleep(for: timeout)
        expire(id)
      }
    }
  }

  private func poll(_ instanceId: String) async -> JSONValue {
    instances[instanceId]?.polls += 1

    if !queue.isEmpty { return .object(["command": queue.removeFirst()]) }

    let key = UUID()
    let reply = await withCheckedContinuation { continuation in
      openPolls[key] = OpenPoll(instance: instanceId, openedAt: .now, continuation: continuation)

      Task {
        try? await Task.sleep(for: Self.pollHold)
        openPolls.removeValue(forKey: key)?.continuation.resume(returning: .object(["command": .null]))
      }
    }
    lastSeen = .now
    return reply
  }

  private func expire(_ id: String) {
    guard let continuation = pending.removeValue(forKey: id) else { return }

    let wasQueued = queue.contains { $0["id"]?.string == id }
    queue.removeAll { $0["id"]?.string == id }
    let seen = lastSeen.map { "last seen \(Int(Date.now.timeIntervalSince($0)))s ago" } ?? "never seen"
    let reason = wasQueued ? "no background poll arrived (\(seen))" : "delivered to a poll but no result came back (\(seen))"
    continuation.resume(throwing: Failure(description: "timed out: \(reason)"))
  }

  /// Lead (b): SFSafariApplication.dispatchMessage reaches a connectNative port in a loaded background, which restarts polling.
  private func nudge() {
    Task {
      do {
        try await SFSafariApplication.dispatchMessage(withName: "wake", toExtensionWithIdentifier: Self.extensionId, userInfo: nil)
        lastDispatch = "ok at \(Date.now.formatted(date: .omitted, time: .standard))"
      } catch {
        lastDispatch = "failed: \(error.localizedDescription)"
      }

      record("app", event: "dispatchMessage \(lastDispatch ?? "")", at: .now)
    }
  }

  private func touch(_ instanceId: String, startedAt: Double?) {
    lastSeen = .now

    if instances[instanceId] != nil {
      instances[instanceId]?.lastSeen = .now
      return
    }

    let started = startedAt.map { Date(timeIntervalSince1970: $0 / 1000) } ?? .now
    instances[instanceId] = Instance(id: instanceId, startedAt: started, firstSeen: .now, lastSeen: .now)
  }

  private func record(_ instance: String, event: String, at: Date) {
    lifecycle.append(LifecycleEntry(instance: String(instance.prefix(8)), event: event, at: at))
    lifecycle = Array(lifecycle.suffix(200))
  }
}
