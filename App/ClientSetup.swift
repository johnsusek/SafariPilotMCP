import Foundation

/// Connects MCP clients to the server bundled in this app, the way iMCP does.
enum ClientSetup {
  static let serverName = "SafariPilot"
  static let home = FileManager.default.homeDirectoryForCurrentUser
  static let codeConfigURL = home.appending(path: ".claude.json")
  static let codexConfigURL = home.appending(path: ".codex/config.toml")
  static let bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"

  static var serverPath: String { Bundle.main.sharedSupportURL!.appending(path: "safaripilot").path }
  static func resolve(_ path: String) -> String { URL(filePath: path).resolvingSymlinksInPath().path }

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

  static func codeCommand(serverPath: String, credential: String) -> String { "claude mcp add \(serverName) --scope user --env \(HelloRequest.credentialVariable)=\(credential) -- '\(serverPath)' mcp" }

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

  /// Returns the config with this server's entry set in place of any other entry that runs SafariPilot, keeping every other key; nil config means no file yet.
  static func merged(config: Data?, in json: JSONConfig, serverPath: String, credential: String, resolve: (String) -> String) throws -> Data {
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

    servers = servers.filter { !runsSafariPilot($0.value, serverPath: serverPath, resolve: resolve) }
    servers[serverName] = entry(serverPath: serverPath, credential: credential, extra: json.extra)
    root[json.key] = servers
    return try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
  }

  private static func servers(_ config: Data?, key: String) -> [String: Any] { object(config)?[key] as? [String: Any] ?? [:] }

  /// Ready when an entry that runs SafariPilot carries a credential it knows; untrusted when entries run it with none, so every connection asks.
  enum Status {
    case missing, untrusted, ready

    init(credentials: [String?], knows: (String) -> Bool) {
      if credentials.contains(where: { $0.map(knows) ?? false }) {
        self = .ready
      } else {
        self = credentials.isEmpty ? .missing : .untrusted
      }
    }
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

  /// The credential, or nil, of each entry in a JSON config that runs SafariPilot.
  static func jsonCredentials(config: Data?, key: String, serverPath: String, resolve: (String) -> String) -> [String?] {
    servers(config, key: key).values.filter { runsSafariPilot($0, serverPath: serverPath, resolve: resolve) }.map { (($0 as? [String: Any])?["env"] as? [String: Any])?[HelloRequest.credentialVariable] as? String }
  }

  /// The config without SafariPilot's own entry or any other entry that runs it, and the credentials those entries held.
  static func removed(config: Data, key: String, serverPath: String, resolve: (String) -> String) throws -> (config: Data, credentials: [String]) {
    guard var root = object(config) else { throw SetupError.notAnObject("The config") }

    let servers = root[key] as? [String: Any] ?? [:]
    let gone = servers.filter { $0.key == serverName || runsSafariPilot($0.value, serverPath: serverPath, resolve: resolve) }
    root[key] = servers.filter { gone[$0.key] == nil }
    let credentials = gone.values.compactMap { (($0 as? [String: Any])?["env"] as? [String: Any])?[HelloRequest.credentialVariable] as? String }
    return (try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]), credentials)
  }

  /// A Claude Code server that runs SafariPilot; project is nil for user scope, else the folder of a local-scope server.
  struct CodeServer: Equatable {
    var name: String
    var project: String?
    var credential: String?
  }

  static func codeServers(config: Data?, serverPath: String, resolve: (String) -> String) -> [CodeServer] {
    let root = object(config) ?? [:]
    let projects = (root["projects"] as? [String: Any] ?? [:]).map { ($0.key as String?, ($0.value as? [String: Any])?["mcpServers"] as? [String: Any] ?? [:]) }
    let scopes = [(nil, root["mcpServers"] as? [String: Any] ?? [:])] + projects

    return scopes.flatMap { project, servers in
      servers.filter { runsSafariPilot($0.value, serverPath: serverPath, resolve: resolve) }.map { name, entry in
        CodeServer(name: name, project: project, credential: ((entry as? [String: Any])?["env"] as? [String: Any])?[HelloRequest.credentialVariable] as? String)
      }
    }.sorted { ($0.project ?? "", $0.name) < ($1.project ?? "", $1.name) }
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

  /// Codex servers named SafariPilot or running it, which removal deletes.
  static func codexOwnServers(config: Data?, serverPath: String, resolve: (String) -> String) -> [String: CodexServer] {
    codexServers(toml: config).filter { name, server in name == serverName || server.command.map(resolve) == resolve(serverPath) }
  }
}
