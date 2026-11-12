import Foundation
import Testing

struct ClaudeSetupTests {
  let path = "/Applications/SafariPilot.app/Contents/SharedSupport/safaripilot"

  func object(_ data: Data) throws -> [String: Any] { try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any]) }

  @Test func createsConfigWhenMissing() throws {
    let merged = try ClaudeSetup.merged(config: nil, serverPath: path)
    #expect(ClaudeSetup.isAdded(config: merged, serverPath: path))
    #expect(String(decoding: merged, as: UTF8.self).contains("/Applications/SafariPilot.app"))
  }

  @Test func keepsOtherServersAndKeys() throws {
    let config = Data(#"{"mcpServers":{"iMCP":{"command":"/Applications/iMCP.app/Contents/MacOS/imcp-server"}},"preferences":{"theme":"dark"}}"#.utf8)
    let root = try object(ClaudeSetup.merged(config: config, serverPath: path))
    let servers = try #require(root["mcpServers"] as? [String: Any])
    #expect(Set(servers.keys) == ["iMCP", "safaripilot"])
    #expect((root["preferences"] as? [String: Any])?["theme"] as? String == "dark")
  }

  @Test func replacesAStaleEntry() throws {
    let config = Data(#"{"mcpServers":{"safaripilot":{"command":"/old/safaripilot","args":["mcp"]}}}"#.utf8)
    #expect(!ClaudeSetup.isAdded(config: config, serverPath: path))
    #expect(ClaudeSetup.isAdded(config: try ClaudeSetup.merged(config: config, serverPath: path), serverPath: path))
  }

  @Test func refusesConfigsThatAreNotObjects() {
    #expect(throws: (any Error).self) { try ClaudeSetup.merged(config: Data("[1]".utf8), serverPath: path) }
    #expect(throws: (any Error).self) { try ClaudeSetup.merged(config: Data(#"{"mcpServers":[]}"#.utf8), serverPath: path) }
    #expect(throws: (any Error).self) { try ClaudeSetup.merged(config: Data("{not json".utf8), serverPath: path) }
  }

  @Test func codeCommandQuotesThePath() {
    #expect(ClaudeSetup.codeCommand(serverPath: "/A B/safaripilot") == "claude mcp add --scope user safaripilot -- '/A B/safaripilot' mcp")
  }
}
