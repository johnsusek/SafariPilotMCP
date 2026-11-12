import Foundation

/// Connects Claude Desktop and Claude Code to the MCP server bundled in this app, the way iMCP does.
enum ClaudeSetup {
  static let serverName = "safaripilot"
  static let desktopConfigURL = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Application Support/Claude/claude_desktop_config.json")

  static var serverPath: String { Bundle.main.sharedSupportURL!.appending(path: "safaripilot").path }

  static func codeCommand(serverPath: String) -> String { "claude mcp add --scope user \(serverName) -- '\(serverPath)' mcp" }

  enum SetupError: Error, CustomStringConvertible {
    case notAnObject(String)

    var description: String {
      switch self {
      case .notAnObject(let what): "\(what) is not a JSON object, so it was left unchanged."
      }
    }
  }

  /// Returns the config with this server's entry set, keeping every other key; nil config means no file yet.
  static func merged(config: Data?, serverPath: String) throws -> Data {
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

    servers[serverName] = ["command": serverPath, "args": ["mcp"]]
    root["mcpServers"] = servers
    return try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
  }

  static func isAdded(config: Data?, serverPath: String) -> Bool {
    guard let config, let root = try? JSONSerialization.jsonObject(with: config) as? [String: Any] else { return false }
    guard let entry = (root["mcpServers"] as? [String: Any])?[serverName] as? [String: Any] else { return false }
    return entry["command"] as? String == serverPath && entry["args"] as? [String] == ["mcp"]
  }
}
