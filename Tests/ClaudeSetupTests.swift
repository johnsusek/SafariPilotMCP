import Foundation
import Testing

struct ClaudeSetupTests {
  let path = "/Applications/SafariPilot.app/Contents/SharedSupport/safaripilot"
  let credential = "sp_test"

  func object(_ data: Data) throws -> [String: Any] { try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any]) }

  @Test func createsConfigWhenMissing() throws {
    let merged = try ClaudeSetup.merged(config: nil, serverPath: path, credential: credential)
    #expect(ClaudeSetup.isAdded(config: merged, serverPath: path) { $0 == credential })
    #expect(ClaudeSetup.credential(in: merged) == credential)
    #expect(String(decoding: merged, as: UTF8.self).contains("/Applications/SafariPilot.app"))
  }

  @Test func keepsOtherServersAndKeys() throws {
    let config = Data(#"{"mcpServers":{"iMCP":{"command":"/Applications/iMCP.app/Contents/MacOS/imcp-server"}},"preferences":{"theme":"dark"}}"#.utf8)
    let root = try object(ClaudeSetup.merged(config: config, serverPath: path, credential: credential))
    let servers = try #require(root["mcpServers"] as? [String: Any])
    #expect(Set(servers.keys) == ["iMCP", "safaripilot"])
    #expect((root["preferences"] as? [String: Any])?["theme"] as? String == "dark")
  }

  @Test func staleEntriesAndUnknownCredentialsAreNotAdded() throws {
    let stale = Data(#"{"mcpServers":{"safaripilot":{"command":"/old/safaripilot","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_test"}}}}"#.utf8)
    #expect(!ClaudeSetup.isAdded(config: stale, serverPath: path) { _ in true })
    let noCredential = Data(#"{"mcpServers":{"safaripilot":{"command":"\#(path)","args":["mcp"]}}}"#.utf8)
    #expect(!ClaudeSetup.isAdded(config: noCredential, serverPath: path) { _ in true })
    let merged = try ClaudeSetup.merged(config: stale, serverPath: path, credential: credential)
    #expect(!ClaudeSetup.isAdded(config: merged, serverPath: path) { _ in false })
    #expect(ClaudeSetup.isAdded(config: merged, serverPath: path) { _ in true })
  }

  @Test func refusesConfigsThatAreNotObjects() {
    #expect(throws: (any Error).self) { try ClaudeSetup.merged(config: Data("[1]".utf8), serverPath: path, credential: credential) }
    #expect(throws: (any Error).self) { try ClaudeSetup.merged(config: Data(#"{"mcpServers":[]}"#.utf8), serverPath: path, credential: credential) }
    #expect(throws: (any Error).self) { try ClaudeSetup.merged(config: Data("{not json".utf8), serverPath: path, credential: credential) }
  }

  @Test func codeCommandCarriesTheCredentialAndQuotesThePath() {
    #expect(ClaudeSetup.codeCommand(serverPath: "/A B/safaripilot", credential: "sp_x") == "claude mcp add --scope user --env SAFARIPILOT_CREDENTIAL=sp_x safaripilot -- '/A B/safaripilot' mcp")
  }

  let links = ["/opt/homebrew/bin/safaripilot": "/Applications/SafariPilot.app/Contents/SharedSupport/safaripilot"]
  func resolve(_ path: String) -> String { links[path] ?? path }
  func data(_ json: String) -> Data { Data(json.utf8) }

  func desktop(config: String? = nil) -> Bool {
    ClaudeSetup.desktopHasServer(config: config.map(data), serverPath: path, resolve: resolve) { $0 == credential }
  }

  func code(config: String? = nil) -> Bool {
    ClaudeSetup.codeHasServer(config: config.map(data), serverPath: path, resolve: resolve)
  }

  @Test func desktopFindsEveryKindOfSetup() {
    #expect(!desktop())
    #expect(desktop(config: #"{"mcpServers":{"safaripilot":{"command":"\#(path)","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_test"}}}}"#))
    #expect(desktop(config: #"{"mcpServers":{"browser":{"command":"/opt/homebrew/bin/safaripilot","args":["mcp"]}}}"#))
    #expect(!desktop(config: #"{"mcpServers":{"other":{"command":"node","args":["/Users/me/SafariPilot/index.js"]}}}"#))
  }

  @Test func desktopKeepsReAddingAStaleOwnEntry() {
    #expect(!desktop(config: #"{"mcpServers":{"safaripilot":{"command":"/old/safaripilot","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_test"}}}}"#))
    #expect(!desktop(config: #"{"mcpServers":{"safaripilot":{"command":"\#(path)","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_gone"}}}}"#))
  }

  @Test func codeFindsUserAndProjectServers() {
    #expect(!code())
    #expect(code(config: #"{"mcpServers":{"safaripilot":{"type":"stdio","command":"\#(path)","args":["mcp"],"env":{}}}}"#))
    #expect(code(config: #"{"projects":{"/Users/me/app":{"mcpServers":{"browser":{"command":"/opt/homebrew/bin/safaripilot","args":["mcp"]}}}}}"#))
    #expect(!code(config: #"{"mcpServers":{"safaripilot":{"command":"/old/safaripilot","args":["mcp"]}},"projects":{"/Users/me/app":{"mcpServers":{}}}}"#))
  }
}
