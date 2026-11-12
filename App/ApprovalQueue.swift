import Foundation

/// Limits that keep a client from opening approval dialogs faster than a person can answer them.
struct ApprovalPolicy: Sendable {
  var maximumShown = 3
  var maximumWaiting = 8
  var expiry: Duration = .seconds(120)
  var denialCooldown: Duration = .seconds(30)
}

/// Approval requests waiting for a person. Requests with the same key share one dialog and one decision;
/// at most `maximumShown` dialogs are on screen and the rest wait their turn.
struct ApprovalQueue<Request, Waiter> {
  typealias Instant = ContinuousClock.Instant

  struct Entry {
    let key: String
    let cooldownKey: String?
    let request: Request
    let deadline: Instant
    fileprivate(set) var waiters: [Waiter]
    fileprivate(set) var shown: Bool
  }

  enum Admission: Equatable {
    case show(deadline: Instant)
    case joined
    case queued(deadline: Instant)
    case rejected(String)
  }

  /// Entries a decision or expiry removed, and queued entries whose dialogs to show now.
  struct Resolution {
    var removed: [Entry] = []
    var promoted: [Entry] = []
  }

  let policy: ApprovalPolicy
  private(set) var entries: [Entry] = []
  private var cooldowns: [String: Instant] = [:]

  init(policy: ApprovalPolicy = ApprovalPolicy()) { self.policy = policy }

  var waitingCount: Int { entries.reduce(0) { $0 + $1.waiters.count } }
  var shownCount: Int { entries.count { $0.shown } }

  mutating func enqueue(key: String, cooldownKey: String?, request: Request, waiter: Waiter, now: Instant) -> Admission {
    if let cooldownKey, let until = cooldowns[cooldownKey] {
      if now < until { return .rejected("this client was denied less than \(policy.denialCooldown.components.seconds) s ago") }

      cooldowns[cooldownKey] = nil
    }

    guard waitingCount < policy.maximumWaiting else { return .rejected("too many clients are waiting for approval") }

    if let index = entries.firstIndex(where: { $0.key == key }) {
      entries[index].waiters.append(waiter)
      return .joined
    }

    let deadline = now.advanced(by: policy.expiry)
    let shown = shownCount < policy.maximumShown
    entries.append(Entry(key: key, cooldownKey: cooldownKey, request: request, deadline: deadline, waiters: [waiter], shown: shown))
    return shown ? .show(deadline: deadline) : .queued(deadline: deadline)
  }

  /// Removes the entry a person decided; a denial starts its cooldown.
  mutating func resolve(key: String, approved: Bool, now: Instant) -> Resolution {
    guard let index = entries.firstIndex(where: { $0.key == key }) else { return Resolution() }

    let entry = entries.remove(at: index)

    if !approved, let cooldownKey = entry.cooldownKey { cooldowns[cooldownKey] = now.advanced(by: policy.denialCooldown) }

    return Resolution(removed: [entry], promoted: promote())
  }

  /// Removes entries past their deadline as denials.
  mutating func expire(now: Instant) -> Resolution {
    let expired = entries.filter { $0.deadline <= now }

    guard !expired.isEmpty else { return Resolution() }

    entries.removeAll { $0.deadline <= now }

    for cooldownKey in expired.compactMap(\.cooldownKey) { cooldowns[cooldownKey] = now.advanced(by: policy.denialCooldown) }

    return Resolution(removed: expired, promoted: promote())
  }

  /// Shows queued entries, oldest first, while there is room.
  private mutating func promote() -> [Entry] {
    var promoted: [Entry] = []

    for index in entries.indices where !entries[index].shown {
      guard shownCount < policy.maximumShown else { break }

      entries[index].shown = true
      promoted.append(entries[index])
    }

    return promoted
  }
}
