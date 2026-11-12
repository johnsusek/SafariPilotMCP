import CryptoKit
import Foundation
import Security

/// A secret SafariPilot issues to one MCP client, which presents it through `HelloRequest.credentialVariable`;
/// only its SHA-256 identifier is stored, so the credential cannot be read back from the app.
enum ClientCredential {
  static let prefix = "sp_"

  static func generate() -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
    return prefix + Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  /// The stored identifier for `credential`, or nil when it is not in the format `generate()` returns.
  static func identifier(for credential: String) -> String? {
    guard credential.hasPrefix(prefix) else { return nil }

    let body = credential.dropFirst(prefix.count).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let padded = body + String(repeating: "=", count: (4 - body.count % 4) % 4)

    guard let bytes = Data(base64Encoded: padded), bytes.count == 32 else { return nil }

    return SHA256.hash(data: Data(credential.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

/// The name a client reports in `initialize`, which it chooses freely, made safe to show in the approval dialog.
enum ClientName {
  static let maximumLength = 64
  static let unnamed = "Unnamed Client"

  /// One line, no control or invisible formatting characters (bidirectional overrides included), at most 64 characters.
  static func sanitized(_ name: String) -> String {
    let hidden: Set<Unicode.GeneralCategory> = [.control, .format, .lineSeparator, .paragraphSeparator, .privateUse, .surrogate, .unassigned]
    let kept = name.unicodeScalars.map { hidden.contains($0.properties.generalCategory) ? " " : String($0) }.joined()
    let collapsed = kept.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return collapsed.isEmpty ? unnamed : String(collapsed.prefix(maximumLength))
  }
}

/// What the app stores about a credential it issued.
struct ClientRecord: Codable, Equatable, Identifiable, Sendable {
  /// The credential's identifier from `ClientCredential.identifier(for:)`.
  let id: String
  let name: String
  let issuedAt: Date
  /// Trusted credentials connect without a dialog. Setup buttons issue untrusted ones, so the first approval can trust them.
  var trusted: Bool
}

protocol ClientRecordStorage {
  func loadAll() throws -> [ClientRecord]
  func save(_ record: ClientRecord) throws
  func delete(id: String) throws
}

/// Issues, finds, trusts and removes client records, keeping a copy in memory.
@MainActor
final class ClientStore {
  private let storage: any ClientRecordStorage
  private(set) var records: [ClientRecord]

  init(storage: any ClientRecordStorage) throws {
    self.storage = storage
    records = try storage.loadAll()
  }

  func record(for credential: String?) -> ClientRecord? {
    guard let id = credential.flatMap(ClientCredential.identifier(for:)) else { return nil }
    return records.first { $0.id == id }
  }

  /// Issues a credential; issuing an untrusted one for a name replaces earlier untrusted ones for that name, which were never approved.
  func issue(name: String, trusted: Bool) throws -> String {
    if !trusted {
      for stale in records where stale.name == name && !stale.trusted { try remove(id: stale.id) }
    }

    let credential = ClientCredential.generate()
    let record = ClientRecord(id: ClientCredential.identifier(for: credential)!, name: name, issuedAt: .now, trusted: trusted)
    try storage.save(record)
    records.append(record)
    return credential
  }

  func trust(id: String) throws {
    guard let index = records.firstIndex(where: { $0.id == id }) else { return }

    var record = records[index]
    record.trusted = true
    try storage.save(record)
    records[index] = record
  }

  func remove(id: String) throws {
    try storage.delete(id: id)
    records.removeAll { $0.id == id }
  }
}

final class MemoryClientRecordStorage: ClientRecordStorage {
  var records: [String: ClientRecord] = [:]

  func loadAll() throws -> [ClientRecord] { Array(records.values) }
  func save(_ record: ClientRecord) throws { records[record.id] = record }
  func delete(id: String) throws { records[id] = nil }
}

/// Client records as generic password items in the data protection keychain, where other apps cannot add, read or change them.
/// Each item holds its record in kSecAttrGeneric and no secret.
struct KeychainClientRecordStorage: ClientRecordStorage {
  struct KeychainError: Error, CustomStringConvertible {
    let status: OSStatus

    var description: String { "keychain error \(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "unknown")" }
  }

  static let service = "net.johnsolo.SafariPilot.clients"

  private var base: [CFString: Any] { [kSecClass: kSecClassGenericPassword, kSecAttrService: Self.service, kSecUseDataProtectionKeychain: true] }

  func loadAll() throws -> [ClientRecord] {
    var query = base
    query[kSecMatchLimit] = kSecMatchLimitAll
    query[kSecReturnAttributes] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)

    if status == errSecItemNotFound { return [] }

    guard status == errSecSuccess else { throw KeychainError(status: status) }

    let items = result as? [[CFString: Any]] ?? []
    return try items.compactMap { $0[kSecAttrGeneric] as? Data }.map { try JSONDecoder().decode(ClientRecord.self, from: $0) }
  }

  func save(_ record: ClientRecord) throws {
    try delete(id: record.id)
    var item = base
    item[kSecAttrAccount] = record.id
    item[kSecAttrLabel] = "SafariPilot client \(record.name)"
    item[kSecAttrGeneric] = try JSONEncoder().encode(record)
    item[kSecValueData] = Data()
    let status = SecItemAdd(item as CFDictionary, nil)

    guard status == errSecSuccess else { throw KeychainError(status: status) }
  }

  func delete(id: String) throws {
    var query = base
    query[kSecAttrAccount] = id
    let status = SecItemDelete(query as CFDictionary)

    guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
  }
}
