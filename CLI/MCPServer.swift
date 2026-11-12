import Foundation
import MCP

/// `safaripilot mcp`: a stdio MCP server whose tools each become one app command. stdout carries only protocol messages.
enum MCPServer {
  static func run() async throws {
    let server = Server(name: "safaripilot", version: "0.1", capabilities: .init(tools: .init(listChanged: false)))
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
      let command = try Tools.command(name: params.name, arguments: arguments)
      let reply = try await exchange(command)

      let text = Tool.Content.text(text: reply.text, annotations: nil, _meta: nil)

      if !reply.ok { log("\(params.name) failed: \(reply.text.prefix(200))") }

      if reply.ok, let png = reply.data["png"]?.string { return .init(content: [.image(data: png, mimeType: "image/png", annotations: nil, _meta: nil), text], isError: false) }

      return .init(content: [text], isError: !reply.ok)
    } catch {
      log("\(params.name) failed: \(error)")
      return .init(content: [.text(text: "\(error)", annotations: nil, _meta: nil)], isError: true)
    }
  }

  /// Wire.exchange blocks for up to the whole timeout, so it runs on a dispatch thread instead of the cooperative pool.
  private static func exchange(_ command: AppCommand) async throws -> CLIReply {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global().async { continuation.resume(with: Result { try AppClient.send(command, timeout: CLIRequest.defaultTimeout) }) }
    }
  }

  static func log(_ message: String) { FileHandle.standardError.write(Data("safaripilot mcp: \(message)\n".utf8)) }
}
