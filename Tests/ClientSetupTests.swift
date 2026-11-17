import Foundation
import Testing

struct ClientSetupTests {
  let path = "/Applications/SafariPilot.app/Contents/SharedSupport/safaripilot"
  let credential = "sp_test"
  let desktop = ClientSetup.Client.claudeDesktop.json!
  let vsCode = ClientSetup.Client.vsCode.json!

  func object(_ data: Data) throws -> [String: Any] { try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any]) }

  @Test func createsConfigWhenMissing() throws {
    let merged = try ClientSetup.merged(config: nil, in: desktop, serverPath: path, credential: credential)
    #expect(ClientSetup.isAdded(config: merged, key: "mcpServers", serverPath: path) { $0 == credential })
    #expect(ClientSetup.credential(in: merged, key: "mcpServers") == credential)
    #expect(String(decoding: merged, as: UTF8.self).contains("/Applications/SafariPilot.app"))
  }

  @Test func keepsOtherServersAndKeys() throws {
    let config = Data(#"{"mcpServers":{"iMCP":{"command":"/Applications/iMCP.app/Contents/MacOS/imcp-server"}},"preferences":{"theme":"dark"}}"#.utf8)
    let root = try object(ClientSetup.merged(config: config, in: desktop, serverPath: path, credential: credential))
    let servers = try #require(root["mcpServers"] as? [String: Any])
    #expect(Set(servers.keys) == ["iMCP", "SafariPilot"])
    #expect((root["preferences"] as? [String: Any])?["theme"] as? String == "dark")
  }

  @Test func vsCodeWritesServersWithStdioType() throws {
    let config = Data(#"{"inputs":[],"servers":{"other":{"type":"http","url":"https://example.com/mcp"}}}"#.utf8)
    let merged = try ClientSetup.merged(config: config, in: vsCode, serverPath: path, credential: credential)
    let servers = try #require(try object(merged)["servers"] as? [String: Any])
    let entry = try #require(servers["SafariPilot"] as? [String: Any])
    #expect(Set(servers.keys) == ["other", "SafariPilot"])
    #expect(entry["type"] as? String == "stdio")
    #expect(ClientSetup.isAdded(config: merged, key: "servers", serverPath: path) { $0 == credential })
    #expect(!ClientSetup.isAdded(config: merged, key: "mcpServers", serverPath: path) { _ in true })
  }

  @Test func staleEntriesAndUnknownCredentialsAreNotAdded() throws {
    let stale = Data(#"{"mcpServers":{"SafariPilot":{"command":"/old/safaripilot","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_test"}}}}"#.utf8)
    #expect(!ClientSetup.isAdded(config: stale, key: "mcpServers", serverPath: path) { _ in true })
    let noCredential = Data(#"{"mcpServers":{"SafariPilot":{"command":"\#(path)","args":["mcp"]}}}"#.utf8)
    #expect(!ClientSetup.isAdded(config: noCredential, key: "mcpServers", serverPath: path) { _ in true })
    let merged = try ClientSetup.merged(config: stale, in: desktop, serverPath: path, credential: credential)
    #expect(!ClientSetup.isAdded(config: merged, key: "mcpServers", serverPath: path) { _ in false })
    #expect(ClientSetup.isAdded(config: merged, key: "mcpServers", serverPath: path) { _ in true })
  }

  @Test func refusesConfigsThatAreNotObjects() {
    #expect(throws: (any Error).self) { try ClientSetup.merged(config: Data("[1]".utf8), in: desktop, serverPath: path, credential: credential) }
    #expect(throws: (any Error).self) { try ClientSetup.merged(config: Data(#"{"mcpServers":[]}"#.utf8), in: desktop, serverPath: path, credential: credential) }
    #expect(throws: (any Error).self) { try ClientSetup.merged(config: Data("{not json".utf8), in: desktop, serverPath: path, credential: credential) }
  }

  @Test func snippetIsAStandardEntry() throws {
    let root = try object(Data(ClientSetup.snippet(serverPath: path, credential: credential).utf8))
    #expect(ClientSetup.isAdded(config: try JSONSerialization.data(withJSONObject: root), key: "mcpServers", serverPath: path) { $0 == credential })
  }

  @Test func commandsCarryTheCredential() {
    #expect(ClientSetup.codeCommand(serverPath: "/A B/safaripilot", credential: "sp_x") == "claude mcp add --scope user --env SAFARIPILOT_CREDENTIAL=sp_x SafariPilot -- '/A B/safaripilot' mcp")
    #expect(ClientSetup.codexArguments(serverPath: "/A B/safaripilot", credential: "sp_x") == ["mcp", "add", "--env", "SAFARIPILOT_CREDENTIAL=sp_x", "SafariPilot", "--", "/A B/safaripilot", "mcp"])
  }

  let links = ["/opt/homebrew/bin/safaripilot": "/Applications/SafariPilot.app/Contents/SharedSupport/safaripilot"]
  func resolve(_ path: String) -> String { links[path] ?? path }
  func data(_ json: String) -> Data { Data(json.utf8) }

  func hasDesktop(config: String? = nil) -> Bool {
    ClientSetup.hasServer(config: config.map(data), key: "mcpServers", serverPath: path, resolve: resolve) { $0 == credential }
  }

  func code(config: String? = nil) -> Bool {
    ClientSetup.codeHasServer(config: config.map(data), serverPath: path, resolve: resolve)
  }

  func codex(_ toml: String? = nil) -> Bool {
    ClientSetup.codexHasServer(config: toml.map(data), serverPath: path, resolve: resolve) { $0 == credential }
  }

  @Test func desktopFindsEveryKindOfSetup() {
    #expect(!hasDesktop())
    #expect(hasDesktop(config: #"{"mcpServers":{"SafariPilot":{"command":"\#(path)","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_test"}}}}"#))
    #expect(hasDesktop(config: #"{"mcpServers":{"browser":{"command":"/opt/homebrew/bin/safaripilot","args":["mcp"]}}}"#))
    #expect(!hasDesktop(config: #"{"mcpServers":{"other":{"command":"node","args":["/Users/me/SafariPilot/index.js"]}}}"#))
  }

  @Test func desktopKeepsReAddingAStaleOwnEntry() {
    #expect(!hasDesktop(config: #"{"mcpServers":{"SafariPilot":{"command":"/old/safaripilot","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_test"}}}}"#))
    #expect(!hasDesktop(config: #"{"mcpServers":{"SafariPilot":{"command":"\#(path)","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_gone"}}}}"#))
  }

  @Test func codeFindsUserAndProjectServers() {
    #expect(!code())
    #expect(code(config: #"{"mcpServers":{"SafariPilot":{"type":"stdio","command":"\#(path)","args":["mcp"],"env":{}}}}"#))
    #expect(code(config: #"{"projects":{"/Users/me/app":{"mcpServers":{"browser":{"command":"/opt/homebrew/bin/safaripilot","args":["mcp"]}}}}}"#))
    #expect(!code(config: #"{"mcpServers":{"SafariPilot":{"command":"/old/safaripilot","args":["mcp"]}},"projects":{"/Users/me/app":{"mcpServers":{}}}}"#))
  }

  @Test func readsTheTablesCodexWrites() {
    let toml = """
      model = "gpt-5"

      [mcp_servers.node_repl]
      command = "/Applications/ChatGPT.app/node_repl"

      [mcp_servers.SafariPilot]
      command = "/A \\"B\\"/safaripilot"
      args = ["mcp"]

      [mcp_servers.SafariPilot.env]
      SAFARIPILOT_CREDENTIAL = "sp_a"

      [mcp_servers."my.browser"]
      command = '/opt/homebrew/bin/safaripilot'
      env = { SAFARIPILOT_CREDENTIAL = "sp_b", OTHER = "x" }

      [mcp_servers.node_repl.tools.run]
      command = "ignored"
      """
    let servers = ClientSetup.codexServers(toml: data(toml))
    #expect(servers["node_repl"] == ClientSetup.CodexServer(command: "/Applications/ChatGPT.app/node_repl"))
    #expect(servers["SafariPilot"] == ClientSetup.CodexServer(command: #"/A "B"/safaripilot"#, credential: "sp_a"))
    #expect(servers["my.browser"] == ClientSetup.CodexServer(command: "/opt/homebrew/bin/safaripilot", credential: "sp_b"))
    #expect(servers.count == 3)
  }

  @Test func codexFindsOwnAndOtherEntries() {
    #expect(!codex())
    #expect(codex("[mcp_servers.SafariPilot]\ncommand = \"\(path)\"\n[mcp_servers.SafariPilot.env]\nSAFARIPILOT_CREDENTIAL = \"sp_test\"\n"))
    #expect(!codex("[mcp_servers.SafariPilot]\ncommand = \"\(path)\"\n[mcp_servers.SafariPilot.env]\nSAFARIPILOT_CREDENTIAL = \"sp_gone\"\n"))
    #expect(!codex("[mcp_servers.SafariPilot]\ncommand = \"/old/safaripilot\"\n[mcp_servers.SafariPilot.env]\nSAFARIPILOT_CREDENTIAL = \"sp_test\"\n"))
    #expect(codex("[mcp_servers.browser]\ncommand = \"/opt/homebrew/bin/safaripilot\"\n"))
    #expect(!codex("[profiles.safaripilot]\ncommand = \"\(path)\"\n"))
  }
}
