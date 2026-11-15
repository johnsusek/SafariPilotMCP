import Foundation

/// Connects MCP clients to the server bundled in this app, the way iMCP does.
enum ClientSetup {
  static let serverName = "safaripilot"
  static let home = FileManager.default.homeDirectoryForCurrentUser
  static let codeConfigURL = home.appending(path: ".claude.json")
  static let codexConfigURL = home.appending(path: ".codex/config.toml")
  static let bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"

  static var serverPath: String { Bundle.main.sharedSupportURL!.appending(path: "safaripilot").path }

  /// A JSON config file, the key holding its servers, and fields that client wants beside command, args and env.
  struct JSONConfig {
    let url: URL
    let key: String
    var extra: [String: String] = [:]
  }

  enum Client: String, CaseIterable, Identifiable {
    case claudeDesktop = "Claude Desktop"
    case claudeCode = "Claude Code"
    case codex = "ChatGPT and Codex"
    case cursor = "Cursor"
    case vsCode = "VS Code"
    case lmStudio = "LM Studio"

    var id: Self { self }

    var json: JSONConfig? {
      switch self {
      case .claudeDesktop: JSONConfig(url: home.appending(path: "Library/Application Support/Claude/claude_desktop_config.json"), key: "mcpServers")
      case .cursor: JSONConfig(url: home.appending(path: ".cursor/mcp.json"), key: "mcpServers")
      case .vsCode: JSONConfig(url: home.appending(path: "Library/Application Support/Code/User/mcp.json"), key: "servers", extra: ["type": "stdio"])
      case .lmStudio: JSONConfig(url: home.appending(path: ".lmstudio/mcp.json"), key: "mcpServers")
      case .claudeCode, .codex: nil
      }
    }
  }

  static func codeCommand(serverPath: String, credential: String) -> String { "claude mcp add --scope user --env \(HelloRequest.credentialVariable)=\(credential) \(serverName) -- '\(serverPath)' mcp" }

  /// Arguments for codex, which writes the entry into the config.toml that ChatGPT's Mac app and Codex CLI share.
  static func codexArguments(serverPath: String, credential: String) -> [String] { ["mcp", "add", "--env", "\(HelloRequest.credentialVariable)=\(credential)", serverName, "--", serverPath, "mcp"] }

  enum SetupError: Error, CustomStringConvertible {
    case notAnObject(String)

    var description: String {
      switch self {
      case .notAnObject(let what): "\(what) is not a JSON object, so it was left unchanged."
      }
    }
  }

  static func entry(serverPath: String, credential: String, extra: [String: String] = [:]) -> [String: Any] {
    (extra as [String: Any]).merging(["command": serverPath, "args": ["mcp"], "env": [HelloRequest.credentialVariable: credential]]) { $1 }
  }

  /// A standard mcpServers entry for clients SafariPilot can't set up itself.
  static func snippet(serverPath: String, credential: String) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: ["mcpServers": [serverName: entry(serverPath: serverPath, credential: credential)]], options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    return String(decoding: data, as: UTF8.self)
  }

  /// Returns the config with this server's entry set, keeping every other key; nil config means no file yet.
  static func merged(config: Data?, in json: JSONConfig, serverPath: String, credential: String) throws -> Data {
    var root: [String: Any] = [:]

    if let config, !config.isEmpty {
      guard let object = try JSONSerialization.jsonObject(with: config) as? [String: Any] else { throw SetupError.notAnObject(json.url.lastPathComponent) }
      root = object
    }

    var servers: [String: Any] = [:]

    if let existing = root[json.key] {
      guard let object = existing as? [String: Any] else { throw SetupError.notAnObject(json.key) }
      servers = object
    }

    servers[serverName] = entry(serverPath: serverPath, credential: credential, extra: json.extra)
    root[json.key] = servers
    return try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
  }

  private static func servers(_ config: Data?, key: String) -> [String: Any] { object(config)?[key] as? [String: Any] ?? [:] }

  static func credential(in config: Data?, key: String) -> String? { ((servers(config, key: key)[serverName] as? [String: Any])?["env"] as? [String: Any])?[HelloRequest.credentialVariable] as? String }

  /// Added means this app's binary, the mcp argument, and a credential SafariPilot still knows.
  static func isAdded(config: Data?, key: String, serverPath: String, knows: (String) -> Bool) -> Bool {
    guard let entry = servers(config, key: key)[serverName] as? [String: Any], let credential = credential(in: config, key: key) else { return false }
    return entry["command"] as? String == serverPath && entry["args"] as? [String] == ["mcp"] && knows(credential)
  }

  private static func object(_ data: Data?) -> [String: Any]? {
    guard let data else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }

  /// Runs this app's CLI directly or through a symlink.
  static func runsSafariPilot(_ entry: Any, serverPath: String, resolve: (String) -> String) -> Bool {
    guard let command = (entry as? [String: Any])?["command"] as? String else { return false }
    return resolve(command) == resolve(serverPath)
  }

  /// The config has SafariPilot through this app's own entry or another entry that runs it.
  static func hasServer(config: Data?, key: String, serverPath: String, resolve: (String) -> String, knows: (String) -> Bool) -> Bool {
    if isAdded(config: config, key: key, serverPath: serverPath, knows: knows) { return true }

    return servers(config, key: key).contains { $0.key != serverName && runsSafariPilot($0.value, serverPath: serverPath, resolve: resolve) }
  }

  /// Claude Code has SafariPilot through a user or project server that runs it.
  static func codeHasServer(config: Data?, serverPath: String, resolve: (String) -> String) -> Bool {
    let root = object(config) ?? [:]
    let projects = (root["projects"] as? [String: Any] ?? [:]).values.compactMap { ($0 as? [String: Any])?["mcpServers"] as? [String: Any] }
    let servers = ([root["mcpServers"] as? [String: Any] ?? [:]] + projects).flatMap(\.values)

    return servers.contains { runsSafariPilot($0, serverPath: serverPath, resolve: resolve) }
  }

  struct CodexServer: Equatable {
    var command: String?
    var credential: String?
  }

  /// Each [mcp_servers.NAME] table's command and credential, read line by line in the shapes codex mcp add writes and inline env tables.
  static func codexServers(toml: Data?) -> [String: CodexServer] {
    var servers: [String: CodexServer] = [:]
    var table: (name: String, env: Bool)?

    for line in String(decoding: toml ?? Data(), as: UTF8.self).split(whereSeparator: \.isNewline) {
      let text = line.trimmingCharacters(in: .whitespaces)

      if text.hasPrefix("[") {
        table = codexTable(text)
        continue
      }

      guard let table, let equals = text.firstIndex(of: "=") else { continue }

      let key = unquoted(text[..<equals].trimmingCharacters(in: .whitespaces))
      let value = text[text.index(after: equals)...].trimmingCharacters(in: .whitespaces)

      if table.env, key == HelloRequest.credentialVariable { servers[table.name, default: CodexServer()].credential = tomlString(value) }

      if !table.env, key == "command" { servers[table.name, default: CodexServer()].command = tomlString(value) }

      if !table.env, key == "env", let range = value.range(of: HelloRequest.credentialVariable) {
        let rest = value[range.upperBound...].drop { $0 == " " || $0 == "\"" }

        if rest.first == "=" { servers[table.name, default: CodexServer()].credential = tomlString(rest.dropFirst().trimmingCharacters(in: .whitespaces)) }
      }
    }

    return servers
  }

  private static func codexTable(_ header: String) -> (name: String, env: Bool)? {
    guard header.hasPrefix("[mcp_servers."), !header.hasPrefix("[["), let close = header.lastIndex(of: "]") else { return nil }

    let path = String(header[header.index(header.startIndex, offsetBy: 13)..<close])

    if path.hasSuffix(".env") { return (unquoted(String(path.dropLast(4))), true) }

    return path.contains(".") && !path.hasPrefix("\"") ? nil : (unquoted(path), false)
  }

  private static func unquoted(_ key: String) -> String { key.trimmingCharacters(in: CharacterSet(charactersIn: "\"'")) }

  /// A TOML basic or literal string at the start of the value.
  static func tomlString(_ value: String) -> String? {
    if value.hasPrefix("'") { return value.dropFirst().firstIndex(of: "'").map { String(value[value.index(after: value.startIndex)..<$0]) } }

    guard value.hasPrefix("\"") else { return nil }

    var text = ""
    var escaped = false

    for char in value.dropFirst() {
      if escaped {
        text.append(char)
        escaped = false
        continue
      }

      if char == "\\" {
        escaped = true
        continue
      }

      if char == "\"" { return text }

      text.append(char)
    }

    return nil
  }

  /// Codex has SafariPilot through this app's own entry with a known credential, or another entry that runs it.
  static func codexHasServer(config: Data?, serverPath: String, resolve: (String) -> String, knows: (String) -> Bool) -> Bool {
    codexServers(toml: config).contains { name, server in
      guard let command = server.command, resolve(command) == resolve(serverPath) else { return false }

      if name != serverName { return true }

      return server.credential.map(knows) ?? false
    }
  }
}
