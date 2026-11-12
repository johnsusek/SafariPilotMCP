import Foundation

/// Connects Claude Desktop and Claude Code to the MCP server bundled in this app, the way iMCP does.
enum ClaudeSetup {
  static let serverName = "safaripilot"
  static let desktopConfigURL = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Application Support/Claude/claude_desktop_config.json")

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

  private static func entry(_ config: Data?) -> [String: Any]? {
    guard let config, let root = try? JSONSerialization.jsonObject(with: config) as? [String: Any] else { return nil }
    return (root["mcpServers"] as? [String: Any])?[serverName] as? [String: Any]
  }

  static func credential(in config: Data?) -> String? { (entry(config)?["env"] as? [String: Any])?[HelloRequest.credentialVariable] as? String }

  /// Added means this app's binary, the mcp argument, and a credential SafariPilot still knows.
  static func isAdded(config: Data?, serverPath: String, knows: (String) -> Bool) -> Bool {
    guard let entry = entry(config), let credential = credential(in: config) else { return false }
    return entry["command"] as? String == serverPath && entry["args"] as? [String] == ["mcp"] && knows(credential)
  }
}
