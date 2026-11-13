import Foundation

/// Untyped JSON, for payloads that pass through unchanged or are only partly read.
enum JSONValue: Codable, Sendable, Equatable, ExpressibleByStringLiteral {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  init(stringLiteral value: String) { self = .string(value) }

  init(encoding value: some Encodable) throws { self = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)) }

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()

    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = try .object(container.decode([String: JSONValue].self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()

    switch self {
    case .null: try container.encodeNil()
    case let .bool(value): try container.encode(value)
    case let .number(value): try container.encode(value)
    case let .string(value): try container.encode(value)
    case let .array(value): try container.encode(value)
    case let .object(value): try container.encode(value)
    }
  }

  subscript(key: String) -> JSONValue? {
    guard case let .object(dictionary) = self else { return nil }
    return dictionary[key]
  }

  var string: String? { if case let .string(value) = self { value } else { nil } }
  var bool: Bool? { if case let .bool(value) = self { value } else { nil } }
  var number: Double? { if case let .number(value) = self { value } else { nil } }
  var array: [JSONValue] { if case let .array(value) = self { value } else { [] } }

  func decode<T: Decodable>(_ type: T.Type) throws -> T {
    try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
  }
}
