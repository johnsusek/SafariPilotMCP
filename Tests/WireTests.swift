import Foundation
import Testing

struct WireTests {
  let token = Wire.newToken()

  @Test func tokenIs64LowercaseHexCharactersAndFresh() {
    let text = String(decoding: token, as: UTF8.self)
    #expect(text.count == 64)
    #expect(text.allSatisfy { "0123456789abcdef".contains($0) })
    #expect(Wire.newToken() != token)
  }

  @Test func tokensMatchOnlyWhenEqual() {
    var flipped = token
    flipped[flipped.startIndex + 63] ^= 1
    #expect(Wire.tokensMatch(token, token))
    #expect(!Wire.tokensMatch(flipped, token))
    #expect(!Wire.tokensMatch(token.prefix(63), token))
    #expect(!Wire.tokensMatch(Data(), token))
  }

  @Test func incompleteTokenLineWaitsForMoreBytes() {
    #expect(Wire.authenticate(token.prefix(10), token: token) == nil)
  }

  @Test func validTokenLineYieldsTheRest() throws {
    let body = Data(#"{"kind":"cli"}"#.utf8) + Data([0x0A])
    let rest = try #require(Wire.authenticate(token + Data([0x0A]) + body, token: token)).get()
    #expect(rest == body)
  }

  @Test func validTokenInASlicedBufferYieldsTheRest() throws {
    let framed = Data("xx".utf8) + token + Data([0x0A]) + Data("{}".utf8)
    let rest = try #require(Wire.authenticate(framed.dropFirst(2), token: token)).get()
    #expect(rest == Data("{}".utf8))
  }

  @Test func newlineIsFoundFromAnOffsetInSlices() {
    let line = Data("ab\ncd\n".utf8)
    #expect(Wire.newline(in: line) == 2)
    #expect(Wire.newline(in: line, from: 3) == 5)
    #expect(Wire.newline(in: line, from: 6) == nil)
    #expect(Wire.newline(in: Data("abc".utf8)) == nil)
    let slice = line.dropFirst(3)
    #expect(Wire.newline(in: slice) == 5)
    #expect(slice[..<Wire.newline(in: slice)!] == Data("cd".utf8))
  }

  @Test func wrongOrMissingTokenIsRejected() {
    let bareJSON = Data(#"{"kind":"cli","command":"click"}"#.utf8) + Data([0x0A])
    #expect(rejection(Wire.authenticate(Wire.newToken() + Data([0x0A]), token: token)) == "token mismatch")
    #expect(rejection(Wire.authenticate(bareJSON, token: token)) == "token mismatch")
    #expect(rejection(Wire.authenticate(Data([0x0A]), token: token)) == "token mismatch")
  }

  @Test func overlongFirstLineIsRejectedWithoutNewline() {
    let flood = Data(repeating: 0x61, count: Wire.maxTokenLine + 1)
    #expect(rejection(Wire.authenticate(flood, token: token)) == "no token line")
  }

  @Test func rejectionLineCannotBeMistakenForJSON() {
    #expect((try? JSONSerialization.jsonObject(with: Wire.rejection + Data("token mismatch".utf8), options: [.fragmentsAllowed])) == nil)
  }

  private func rejection(_ result: Result<Data, Failure>?) -> String? {
    guard case let .failure(failure) = result else { return nil }

    return failure.description
  }
}
