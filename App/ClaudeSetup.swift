import Foundation

/// Connects Claude Desktop and Claude Code to the MCP server bundled in this app, the way iMCP does.
enum ClaudeSetup {
  static let serverName = "safaripilot"
  static let home = FileManager.default.homeDirectoryForCurrentUser
  static let desktopConfigURL = home.appending(path: "Library/Application Support/Claude/claude_desktop_config.json")
  static let codeConfigURL = home.appending(path: ".claude.json")

  static var serverPath: String { Bundle.main.sharedSupportURL!.appending(path: "safaripilot").path }

  static func codeCommand(serverPath: String, credential: String) -> String { "claude mcp add --scope user --env \(HelloRequest.credentialVariable)=\(credential) \(serverName) -- '\(serverPath)' mcp" }

  enum SetupError: Error, CustomStringConvertible {
    case notAnObject(String)

    var description: String {
      switch self {
      case .notAnObject(let what): "\(what) is not a JSON object, so it was left unchanged."
      }
    }
  }

  /// Returns the config with this server's entry set, keeping every other key; nil config means no file yet.
  static func merged(config: Data?, serverPath: String, credential: String) throws -> Data {
    var root: [String: Any] = [:]

    if let config, !config.isEmpty {
      guard let object = try JSONSerialization.jsonObject(with: config) as? [String: Any] else { throw SetupError.notAnObject("claude_desktop_config.json") }
      root = object
    }

    var servers: [String: Any] = [:]

    if let existing = root["mcpServers"] {
      guard let object = existing as? [String: Any] else { throw SetupError.notAnObject("mcpServers") }
      servers = object
    }

    servers[serverName] = ["command": serverPath, "args": ["mcp"], "env": [HelloRequest.credentialVariable: credential]]
    root["mcpServers"] = servers
    return try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
  }

  private static func entry(_ config: Data?) -> [String: Any]? { (object(config)?["mcpServers"] as? [String: Any])?[serverName] as? [String: Any] }

  static func credential(in config: Data?) -> String? { (entry(config)?["env"] as? [String: Any])?[HelloRequest.credentialVariable] as? String }

  /// Added means this app's binary, the mcp argument, and a credential SafariPilot still knows.
  static func isAdded(config: Data?, serverPath: String, knows: (String) -> Bool) -> Bool {
    guard let entry = entry(config), let credential = credential(in: config) else { return false }
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

  /// Desktop has SafariPilot through this app's own entry or another config entry that runs it.
  static func desktopHasServer(config: Data?, serverPath: String, resolve: (String) -> String, knows: (String) -> Bool) -> Bool {
    if isAdded(config: config, serverPath: serverPath, knows: knows) { return true }

    let servers = object(config)?["mcpServers"] as? [String: Any] ?? [:]

    return servers.contains { $0.key != serverName && runsSafariPilot($0.value, serverPath: serverPath, resolve: resolve) }
  }

  /// Claude Code has SafariPilot through a user or project server that runs it.
  static func codeHasServer(config: Data?, serverPath: String, resolve: (String) -> String) -> Bool {
    let root = object(config) ?? [:]
    let projects = (root["projects"] as? [String: Any] ?? [:]).values.compactMap { ($0 as? [String: Any])?["mcpServers"] as? [String: Any] }
    let servers = ([root["mcpServers"] as? [String: Any] ?? [:]] + projects).flatMap(\.values)

    return servers.contains { runsSafariPilot($0, serverPath: serverPath, resolve: resolve) }
  }
}
