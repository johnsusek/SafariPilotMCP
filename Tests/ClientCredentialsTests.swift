import Foundation
import Testing

struct ClientCredentialsTests {
  @Test func generatedCredentialsHaveIdentifiers() {
    let credential = ClientCredential.generate()
    #expect(credential.hasPrefix("sp_"))
    #expect(ClientCredential.identifier(for: credential)?.count == 64)
    #expect(ClientCredential.identifier(for: credential) == ClientCredential.identifier(for: credential))
    #expect(ClientCredential.identifier(for: ClientCredential.generate()) != ClientCredential.identifier(for: credential))
  }

  @Test func malformedCredentialsHaveNoIdentifier() {
    #expect(ClientCredential.identifier(for: "") == nil)
    #expect(ClientCredential.identifier(for: "sp_short") == nil)
    #expect(ClientCredential.identifier(for: "imcp_" + ClientCredential.generate().dropFirst(3)) == nil)
  }

  @Test func namesAreSanitized() {
    #expect(ClientName.sanitized("claude-code") == "claude-code")
    #expect(ClientName.sanitized("evil\u{202E}edoc\nAllow") == "evil edoc Allow")
    #expect(ClientName.sanitized(" \u{200B}\t") == ClientName.unnamed)
    #expect(ClientName.sanitized(String(repeating: "a", count: 100)).count == 64)
  }

  @MainActor @Test func storeIssuesTrustsAndRemoves() throws {
    let storage = MemoryClientRecordStorage()
    let store = try ClientStore(storage: storage)
    let first = try store.issue(name: "Claude Code", trusted: false)
    let second = try store.issue(name: "Claude Code", trusted: false)
    #expect(store.record(for: first) == nil)
    let record = try #require(store.record(for: second))
    #expect(!record.trusted)

    try store.trust(id: record.id)
    #expect(store.record(for: second)?.trusted == true)
    #expect(try ClientStore(storage: storage).record(for: second)?.trusted == true)

    try store.remove(id: record.id)
    #expect(store.record(for: second) == nil)
    #expect(storage.records.isEmpty)
  }
}
