import Foundation
import MCP
import Synchronization

/// `safaripilot mcp`: a stdio MCP server whose tools each become one app command. stdout carries only protocol messages.
enum MCPServer {
  /// This server process's default tab for page tools; the app decides which tabs it may act on.
  static let session = Mutex(TabSession())
  /// The name and version the client reported in initialize, shown in the approval dialog.
  static let client = Mutex((name: "", version: ""))
  static let approval = Approval()

  static func run() async throws {
    let server = Server(name: "SafariPilot", version: "0.1", instructions: Tools.instructions, capabilities: .init(tools: .init(listChanged: false)))
    let tools = try Tools.definitions.map { try Tool(name: $0.name, description: $0.description, inputSchema: $0.inputSchema.decode(Value.self)) }

    await server.withMethodHandler(ListTools.self) { _ in .init(tools: tools) }
    await server.withMethodHandler(CallTool.self) { params in await call(params) }
    try await server.start(transport: StdioTransport()) { info, _ in client.withLock { $0 = (info.name, info.version) } }
    log("ready with \(tools.count) tools")
    await server.waitUntilCompleted()
  }

  static func call(_ params: CallTool.Parameters) async -> CallTool.Result {
    let result: ToolResult

    do {
      let arguments = try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(params.arguments ?? [:]))
      result = params.name == "browser_batch" ? try await ToolResult.batch(Tools.batchActions(arguments), run: run) : await run(params.name, arguments)
    } catch {
      log("\(params.name) failed: \(error)")
      result = .failed(error)
    }

    let content = result.shown.map { item -> Tool.Content in
      switch item {
      case let .text(body): text(body)
      case let .png(data): .image(data: data, mimeType: "image/png", annotations: nil, _meta: nil)
      }
    }
    let structured = try? result.structured.map { try $0.decode(Value.self) }
    return .init(content: content, structuredContent: structured, isError: !result.ok)
  }

  static func run(_ name: String, _ arguments: [String: JSONValue]) async -> ToolResult {
    do {
      if name == "wait" {
        switch try Tools.wait(arguments, session: session.withLock { $0 }) {
        case let .sleep(seconds):
          try await Task.sleep(for: .seconds(seconds))
          return .text("waited \(seconds.formatted()) s")
        case let .condition(tabId, condition, timeout):
          return try await .text(Wait.poll(condition, tabId: tabId, timeout: timeout, look: exchange))
        }
      }

      let command = try Tools.command(name: name, arguments: arguments, session: session.withLock { $0 })
      let reply = try await exchange(command)
      session.withLock { $0.record(command, reply: reply) }

      if !reply.ok { log("\(name) failed: \(reply.text.prefix(200))") }

      if reply.ok, let png = reply.data["png"]?.string { return ToolResult(items: [.png(png), .text(reply.text)]) }

      return .reply(reply)
    } catch {
      log("\(name) failed: \(error)")
      return .failed(error)
    }
  }

  static func text(_ text: String) -> Tool.Content { .text(text: text, annotations: nil, _meta: nil) }

  /// Sends a command under this process's approved session, asking for approval first when there is none.
  /// A refused session (the app relaunched and forgot it, or the person disconnected it) is dropped, and the command, which never ran, is sent once more under a new one.
  private static func exchange(_ command: AppCommand) async throws -> CLIReply {
    let send = { (key: String) in try await blocking { try AppClient.send(command, timeout: CLIRequest.defaultTimeout, session: key) } }
    let key = try await approval.session()
    let reply = try await send(key)

    guard reply.code == .approvalRequired else { return reply }

    await approval.drop(key)
    let renewed = try await approval.session()
    let retried = try await send(renewed)

    if retried.code == .approvalRequired { await approval.drop(renewed) }

    return retried
  }

  /// Wire.exchange blocks for up to its whole timeout, so it runs on a dispatch thread instead of the cooperative pool.
  static func blocking<Value: Sendable>(_ work: @escaping @Sendable () throws -> Value) async throws -> Value {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global().async { continuation.resume(with: Result { try work() }) }
    }
  }

  static func log(_ message: String) { FileHandle.standardError.write(Data("safaripilot mcp: \(message)\n".utf8)) }
}

/// This process's approval: the first command asks the app, which shows the dialog, and concurrent commands share that one ask.
actor Approval {
  private var key: String?
  private var pending: Task<String, Error>?

  func session() async throws -> String {
    if let key { return key }
    if let pending { return try await pending.value }

    let (name, version) = MCPServer.client.withLock { $0 }
    let credential = ProcessInfo.processInfo.environment[HelloRequest.credentialVariable]
    let task = Task { try await MCPServer.blocking { try AppClient.hello(clientName: name, clientVersion: version, credential: credential) } }
    pending = task
    defer { pending = nil }
    let approved = try await task.value
    key = approved
    return approved
  }

  func drop(_ stale: String) {
    if key == stale { key = nil }
  }
}
