import Foundation
import MCP
import Synchronization

/// `safaripilot mcp`: a stdio MCP server whose tools each become one app command. stdout carries only protocol messages.
enum MCPServer {
  /// The tab this server process opened with tab_create; page tools without tabId act on it.
  static let sessionTab = Mutex<Int?>(nil)

  static func run() async throws {
    let server = Server(name: "safaripilot", version: "0.1", instructions: Tools.instructions, capabilities: .init(tools: .init(listChanged: false)))
    let tools = try Tools.definitions.map { try Tool(name: $0.name, description: $0.description, inputSchema: $0.inputSchema.decode(Value.self)) }

    await server.withMethodHandler(ListTools.self) { _ in .init(tools: tools) }
    await server.withMethodHandler(CallTool.self) { params in await call(params) }
    try await server.start(transport: StdioTransport())
    log("ready with \(tools.count) tools")
    await server.waitUntilCompleted()
  }

  static func call(_ params: CallTool.Parameters) async -> CallTool.Result {
    do {
      let arguments = try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(params.arguments ?? [:]))

      guard params.name == "browser_batch" else {
        let outcome = await run(params.name, arguments)
        return .init(content: outcome.content, isError: !outcome.ok)
      }

      return try await batch(Tools.batchActions(arguments))
    } catch {
      log("\(params.name) failed: \(error)")
      return .init(content: [text("\(error)")], isError: true)
    }
  }

  /// Runs actions in order, labeling each one's output, and stops at the first failure. Text between images is merged into one block joined by line breaks, since clients concatenate blocks with no separator.
  static func batch(_ actions: [(name: String, input: [String: JSONValue])]) async -> CallTool.Result {
    var content: [Tool.Content] = []
    var lines: [String] = []

    func flush() {
      if !lines.isEmpty { content.append(text(lines.joined(separator: "\n"))) }

      lines = []
    }

    for (index, action) in actions.enumerated() {
      let outcome = await run(action.name, action.input)
      lines.append("\(index + 1)/\(actions.count) \(action.name)\(outcome.ok ? "" : " failed"):")

      for item in outcome.content {
        if case let .text(body, _, _) = item {
          lines.append(body)
          continue
        }

        flush()
        content.append(item)
      }

      if !outcome.ok {
        lines.append("stopped after \(index + 1) of \(actions.count) actions")
        flush()
        return .init(content: content, isError: true)
      }
    }

    flush()
    return .init(content: content, isError: false)
  }

  static func run(_ name: String, _ arguments: [String: JSONValue]) async -> (content: [Tool.Content], ok: Bool) {
    do {
      let command = try Tools.command(name: name, arguments: arguments, sessionTab: sessionTab.withLock { $0 })
      let reply = try await exchange(command)
      sessionTab.withLock { $0 = Tools.session(after: command, reply: reply, current: $0) }

      if !reply.ok { log("\(name) failed: \(reply.text.prefix(200))") }

      if reply.ok, let png = reply.data["png"]?.string { return ([.image(data: png, mimeType: "image/png", annotations: nil, _meta: nil), text(reply.text)], true) }

      return ([text(reply.text)], reply.ok)
    } catch {
      log("\(name) failed: \(error)")
      return ([text("\(error)")], false)
    }
  }

  static func text(_ text: String) -> Tool.Content { .text(text: text, annotations: nil, _meta: nil) }

  /// Wire.exchange blocks for up to the whole timeout, so it runs on a dispatch thread instead of the cooperative pool.
  private static func exchange(_ command: AppCommand) async throws -> CLIReply {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global().async { continuation.resume(with: Result { try AppClient.send(command, timeout: CLIRequest.defaultTimeout) }) }
    }
  }

  static func log(_ message: String) { FileHandle.standardError.write(Data("safaripilot mcp: \(message)\n".utf8)) }
}
