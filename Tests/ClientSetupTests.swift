import Foundation
import Testing

struct ClientSetupTests {
  let path = "/Applications/SafariPilot.app/Contents/SharedSupport/safaripilot"
  let credential = "sp_test"
  let desktop = ClientSetup.Client.claudeDesktop.json!
  let vsCode = ClientSetup.Client.vsCode.json!

  func object(_ data: Data) throws -> [String: Any] { try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any]) }

  @Test func createsConfigWhenMissing() throws {
    let merged = try ClientSetup.merged(config: nil, in: desktop, serverPath: path, credential: credential, resolve: resolve)
    #expect(json(merged) == .ready)
    #expect(ClientSetup.jsonCredentials(config: merged, key: "mcpServers", serverPath: path, resolve: resolve) == [credential])
    #expect(String(decoding: merged, as: UTF8.self).contains("/Applications/SafariPilot.app"))
  }

  @Test func keepsOtherServersAndKeys() throws {
    let config = Data(#"{"mcpServers":{"iMCP":{"command":"/Applications/iMCP.app/Contents/MacOS/imcp-server"}},"preferences":{"theme":"dark"}}"#.utf8)
    let root = try object(ClientSetup.merged(config: config, in: desktop, serverPath: path, credential: credential, resolve: resolve))
    let servers = try #require(root["mcpServers"] as? [String: Any])
    #expect(Set(servers.keys) == ["iMCP", "SafariPilot"])
    #expect((root["preferences"] as? [String: Any])?["theme"] as? String == "dark")
  }

  @Test func vsCodeWritesServersWithStdioType() throws {
    let config = Data(#"{"inputs":[],"servers":{"other":{"type":"http","url":"https://example.com/mcp"}}}"#.utf8)
    let merged = try ClientSetup.merged(config: config, in: vsCode, serverPath: path, credential: credential, resolve: resolve)
    let servers = try #require(try object(merged)["servers"] as? [String: Any])
    let entry = try #require(servers["SafariPilot"] as? [String: Any])
    #expect(Set(servers.keys) == ["other", "SafariPilot"])
    #expect(entry["type"] as? String == "stdio")
    #expect(json(merged, key: "servers") == .ready)
    #expect(json(merged) == .missing)
  }

  @Test func staleEntriesAndUnknownCredentialsAreNotAdded() throws {
    let stale = Data(#"{"mcpServers":{"SafariPilot":{"command":"/old/safaripilot","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_test"}}}}"#.utf8)
    #expect(json(stale) == .missing)
    let noCredential = Data(#"{"mcpServers":{"SafariPilot":{"command":"\#(path)","args":["mcp"]}}}"#.utf8)
    #expect(json(noCredential) == .untrusted)
    let merged = try ClientSetup.merged(config: stale, in: desktop, serverPath: path, credential: credential, resolve: resolve)
    #expect(json(merged) { _ in false } == .untrusted)
    #expect(json(merged) == .ready)
  }

  @Test func replacesEntriesThatRunSafariPilotUnderOtherNames() throws {
    let config = data(#"{"mcpServers":{"safaripilot":{"command":"\#(path)","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_old"}},"browser":{"command":"/opt/homebrew/bin/safaripilot"},"iMCP":{"command":"/Applications/iMCP.app/Contents/MacOS/imcp-server"}}}"#)
    let merged = try ClientSetup.merged(config: config, in: desktop, serverPath: path, credential: credential, resolve: resolve)
    let servers = try #require(try object(merged)["mcpServers"] as? [String: Any])
    #expect(Set(servers.keys) == ["iMCP", "SafariPilot"])
    #expect(ClientSetup.jsonCredentials(config: merged, key: "mcpServers", serverPath: path, resolve: resolve) == [credential])
  }

  @Test func refusesConfigsThatAreNotObjects() {
    #expect(throws: (any Error).self) { try ClientSetup.merged(config: Data("[1]".utf8), in: desktop, serverPath: path, credential: credential, resolve: resolve) }
    #expect(throws: (any Error).self) { try ClientSetup.merged(config: Data(#"{"mcpServers":[]}"#.utf8), in: desktop, serverPath: path, credential: credential, resolve: resolve) }
    #expect(throws: (any Error).self) { try ClientSetup.merged(config: Data("{not json".utf8), in: desktop, serverPath: path, credential: credential, resolve: resolve) }
  }

  @Test func snippetIsAStandardEntry() throws {
    let root = try object(Data(ClientSetup.snippet(serverPath: path, credential: credential).utf8))
    #expect(json(try JSONSerialization.data(withJSONObject: root)) == .ready)
  }

  @Test func commandsCarryTheCredential() {
    #expect(ClientSetup.codeCommand(serverPath: "/A B/safaripilot", credential: "sp_x") == "claude mcp add SafariPilot --scope user --env SAFARIPILOT_CREDENTIAL=sp_x -- '/A B/safaripilot' mcp")
    #expect(ClientSetup.codexArguments(serverPath: "/A B/safaripilot", credential: "sp_x") == ["mcp", "add", "--env", "SAFARIPILOT_CREDENTIAL=sp_x", "SafariPilot", "--", "/A B/safaripilot", "mcp"])
  }

  let links = ["/opt/homebrew/bin/safaripilot": "/Applications/SafariPilot.app/Contents/SharedSupport/safaripilot"]
  func resolve(_ path: String) -> String { links[path] ?? path }
  func data(_ json: String) -> Data { Data(json.utf8) }

  func json(_ config: Data?, key: String = "mcpServers", knows: (String) -> Bool = { $0 == "sp_test" }) -> ClientSetup.Status {
    ClientSetup.Status(credentials: ClientSetup.jsonCredentials(config: config, key: key, serverPath: path, resolve: resolve), knows: knows)
  }

  func desktopStatus(_ config: String? = nil) -> ClientSetup.Status { json(config.map(data)) }

  func code(config: String? = nil) -> ClientSetup.Status {
    ClientSetup.Status(credentials: ClientSetup.codeServers(config: config.map(data), serverPath: path, resolve: resolve).map(\.credential)) { $0 == credential }
  }

  func codex(_ toml: String? = nil) -> ClientSetup.Status {
    ClientSetup.Status(credentials: ClientSetup.codexServers(toml: toml.map(data)).values.filter { $0.command.map(resolve) == resolve(path) }.map(\.credential)) { $0 == credential }
  }

  @Test func desktopFindsEveryKindOfSetup() {
    #expect(desktopStatus() == .missing)
    #expect(desktopStatus(#"{"mcpServers":{"SafariPilot":{"command":"\#(path)","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_test"}}}}"#) == .ready)
    #expect(desktopStatus(#"{"mcpServers":{"browser":{"command":"/opt/homebrew/bin/safaripilot","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_test"}}}}"#) == .ready)
    #expect(desktopStatus(#"{"mcpServers":{"other":{"command":"node","args":["/Users/me/SafariPilot/index.js"]}}}"#) == .missing)
  }

  @Test func entriesWithoutAKnownCredentialAreUntrusted() {
    #expect(desktopStatus(#"{"mcpServers":{"SafariPilot":{"command":"/old/safaripilot","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_test"}}}}"#) == .missing)
    #expect(desktopStatus(#"{"mcpServers":{"SafariPilot":{"command":"\#(path)","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_gone"}}}}"#) == .untrusted)
    #expect(desktopStatus(#"{"mcpServers":{"browser":{"command":"/opt/homebrew/bin/safaripilot","args":["mcp"]}}}"#) == .untrusted)
  }

  @Test func codeFindsUserAndProjectServers() {
    #expect(code() == .missing)
    #expect(code(config: #"{"mcpServers":{"SafariPilot":{"type":"stdio","command":"\#(path)","args":["mcp"],"env":{"SAFARIPILOT_CREDENTIAL":"sp_test"}}}}"#) == .ready)
    #expect(code(config: #"{"mcpServers":{"SafariPilot":{"type":"stdio","command":"\#(path)","args":["mcp"],"env":{}}}}"#) == .untrusted)
    #expect(code(config: #"{"projects":{"/Users/me/app":{"mcpServers":{"browser":{"command":"/opt/homebrew/bin/safaripilot","args":["mcp"]}}}}}"#) == .untrusted)
    #expect(code(config: #"{"mcpServers":{"SafariPilot":{"command":"/old/safaripilot","args":["mcp"]}},"projects":{"/Users/me/app":{"mcpServers":{}}}}"#) == .missing)
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
    #expect(codex() == .missing)
    #expect(codex("[mcp_servers.SafariPilot]\ncommand = \"\(path)\"\n[mcp_servers.SafariPilot.env]\nSAFARIPILOT_CREDENTIAL = \"sp_test\"\n") == .ready)
    #expect(codex("[mcp_servers.SafariPilot]\ncommand = \"\(path)\"\n[mcp_servers.SafariPilot.env]\nSAFARIPILOT_CREDENTIAL = \"sp_gone\"\n") == .untrusted)
    #expect(codex("[mcp_servers.SafariPilot]\ncommand = \"/old/safaripilot\"\n[mcp_servers.SafariPilot.env]\nSAFARIPILOT_CREDENTIAL = \"sp_test\"\n") == .missing)
    #expect(codex("[mcp_servers.browser]\ncommand = \"/opt/homebrew/bin/safaripilot\"\n") == .untrusted)
    #expect(codex("[profiles.safaripilot]\ncommand = \"\(path)\"\n") == .missing)
  }

  @Test func removalTakesEveryEntryThatRunsSafariPilot() throws {
    let config = data(#"{"mcpServers":{"SafariPilot":{"command":"/old/safaripilot","env":{"SAFARIPILOT_CREDENTIAL":"sp_a"}},"browser":{"command":"/opt/homebrew/bin/safaripilot","env":{"SAFARIPILOT_CREDENTIAL":"sp_b"}},"iMCP":{"command":"/imcp"}},"theme":"dark"}"#)
    let (removed, credentials) = try ClientSetup.removed(config: config, key: "mcpServers", serverPath: path, resolve: resolve)
    let root = try object(removed)
    #expect(Set((root["mcpServers"] as? [String: Any] ?? [:]).keys) == ["iMCP"])
    #expect(root["theme"] as? String == "dark")
    #expect(Set(credentials) == ["sp_a", "sp_b"])
  }

  @Test func codeListsUserAndLocalServersWithCredentials() {
    let config = data(#"{"mcpServers":{"SafariPilot":{"command":"\#(path)","env":{"SAFARIPILOT_CREDENTIAL":"sp_a"}}},"projects":{"/Users/me/app":{"mcpServers":{"browser":{"command":"/opt/homebrew/bin/safaripilot"},"other":{"command":"node"}}}}}"#)
    #expect(ClientSetup.codeServers(config: config, serverPath: path, resolve: resolve) == [
      ClientSetup.CodeServer(name: "SafariPilot", project: nil, credential: "sp_a"),
      ClientSetup.CodeServer(name: "browser", project: "/Users/me/app", credential: nil),
    ])
  }

  @Test func codexRemovalFindsOwnNameAndOtherEntries() {
    let toml = "[mcp_servers.SafariPilot]\ncommand = \"/old/safaripilot\"\n[mcp_servers.browser]\ncommand = \"/opt/homebrew/bin/safaripilot\"\n[mcp_servers.node]\ncommand = \"node\"\n"
    #expect(Set(ClientSetup.codexOwnServers(config: data(toml), serverPath: path, resolve: resolve).keys) == ["SafariPilot", "browser"])
  }
}
