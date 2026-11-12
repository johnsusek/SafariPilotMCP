import Foundation
import Testing

struct ApprovalQueueTests {
  typealias Queue = ApprovalQueue<String, Int>
  let now = ContinuousClock.now
  let policy = ApprovalPolicy(maximumShown: 1, maximumWaiting: 3, expiry: .seconds(120), denialCooldown: .seconds(30))

  @Test func sameKeySharesOneDialog() {
    var queue = Queue(policy: policy)
    #expect(queue.enqueue(key: "a", cooldownKey: "a", request: "A", waiter: 1, now: now) == .show(deadline: now + .seconds(120)))
    #expect(queue.enqueue(key: "a", cooldownKey: "a", request: "A", waiter: 2, now: now) == .joined)
    let resolution = queue.resolve(key: "a", approved: true, now: now)
    #expect(resolution.removed.first?.waiters == [1, 2])
    #expect(queue.entries.isEmpty)
  }

  @Test func extraDialogsQueueAndPromote() {
    var queue = Queue(policy: policy)
    _ = queue.enqueue(key: "a", cooldownKey: nil, request: "A", waiter: 1, now: now)
    #expect(queue.enqueue(key: "b", cooldownKey: nil, request: "B", waiter: 2, now: now) == .queued(deadline: now + .seconds(120)))
    #expect(queue.resolve(key: "a", approved: true, now: now).promoted.map(\.key) == ["b"])
  }

  @Test func refusesPastTheWaitingLimit() {
    var queue = Queue(policy: policy)

    for index in 0 ..< 3 { _ = queue.enqueue(key: "k\(index)", cooldownKey: nil, request: "", waiter: index, now: now) }

    guard case .rejected = queue.enqueue(key: "k3", cooldownKey: nil, request: "", waiter: 3, now: now) else { Issue.record("expected rejection"); return }
  }

  @Test func denialCoolsDownItsCredential() {
    var queue = Queue(policy: policy)
    _ = queue.enqueue(key: "a", cooldownKey: "cred", request: "A", waiter: 1, now: now)
    _ = queue.resolve(key: "a", approved: false, now: now)

    guard case .rejected = queue.enqueue(key: "a", cooldownKey: "cred", request: "A", waiter: 2, now: now + .seconds(10)) else { Issue.record("expected cooldown"); return }

    #expect(queue.enqueue(key: "a", cooldownKey: "cred", request: "A", waiter: 3, now: now + .seconds(31)) == .show(deadline: now + .seconds(151)))
  }

  @Test func expiryRemovesAsDenialAndPromotes() {
    var queue = Queue(policy: policy)
    _ = queue.enqueue(key: "a", cooldownKey: "cred", request: "A", waiter: 1, now: now)
    _ = queue.enqueue(key: "b", cooldownKey: nil, request: "B", waiter: 2, now: now + .seconds(60))
    #expect(queue.expire(now: now + .seconds(100)).removed.isEmpty)
    let resolution = queue.expire(now: now + .seconds(120))
    #expect(resolution.removed.map(\.key) == ["a"])
    #expect(resolution.promoted.map(\.key) == ["b"])

    guard case .rejected = queue.enqueue(key: "a", cooldownKey: "cred", request: "A", waiter: 3, now: now + .seconds(130)) else { Issue.record("expected cooldown after expiry"); return }
  }
}
