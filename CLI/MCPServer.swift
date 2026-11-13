import Foundation
import MCP
import Synchronization

/// `safaripilot mcp`: a stdio MCP server whose tools each become one app command. stdout carries only protocol messages.
enum MCPServer {
  /// The tabs this server process may see and act on, and its default tab for page tools.
  static let session = Mutex(TabSession())
  /// The name and version the client reported in initialize, shown in the approval dialog.
  static let client = Mutex((name: "", version: ""))
  static let approval = Approval()

  static func run() async throws {
    let server = Server(name: "safaripilot", version: "0.1", instructions: Tools.instructions, capabilities: .init(tools: .init(listChanged: false)))
    let tools = try Tools.definitions.map { try Tool(name: $0.name, description: $0.description, inputSchema: $0.inputSchema.decode(Value.self)) }

    await server.withMethodHandler(ListTools.self) { _ in .init(tools: tools) }
    await server.withMethodHandler(CallTool.self) { params in await call(params) }
    try await server.start(transport: StdioTransport()) { info, _ in client.withLock { $0 = (info.name, info.version) } }
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
      if name == "wait" {
        let seconds = try Tools.waitSeconds(arguments)
        try await Task.sleep(for: .seconds(seconds))
        return ([text("waited \(seconds.formatted()) s")], true)
      }

      let command = try Tools.command(name: name, arguments: arguments, session: session.withLock { $0 })

      if command == .tabs {
        let lines = try await refresh().visible.map(\.line)
        return ([text(lines.isEmpty ? "no tabs: call tab_create to open one" : lines.joined(separator: "\n"))], true)
      }

      if let target = command.targetTab { try await requireOwned(target) }

      let reply = try await exchange(command)
      session.withLock { $0.record(command, reply: reply) }

      if !reply.ok { log("\(name) failed: \(reply.text.prefix(200))") }

      if reply.ok, let png = reply.data["png"]?.string { return ([.image(data: png, mimeType: "image/png", annotations: nil, _meta: nil), text(reply.text)], true) }

      switch command {
      case .click, .key: break
      default: return ([text(reply.text)], reply.ok)
      }

      // A dialog the click or key press opened stops the extension, so tabs cannot be listed until it closes.
      guard reply.ok, reply.data["dialog"] == nil else { return ([text(reply.text)], reply.ok) }

      // A click or key press can open a popup; adopt it now so the caller hears about it.
      // The action already happened, so a failed listing, as when its page opens a dialog a moment later, is reported beside it and not in its place.
      do {
        let opened = try await refresh().adopted.map { "opened tab \($0.id) \($0.url)" }
        return ([text(([reply.text] + opened).joined(separator: "\n"))], true)
      } catch {
        return ([text("\(reply.text)\ntabs could not be listed afterwards to look for popups: \(error)")], true)
      }
    } catch {
      log("\(name) failed: \(error)")
      return ([text("\(error)")], false)
    }
  }

  /// Lists every Safari tab, adopts the ones this session's tabs opened, and returns those plus the session's visible tabs.
  static func refresh() async throws -> (adopted: [TabInfo], visible: [TabInfo]) {
    let reply = try await exchange(.tabs)

    guard reply.ok else { throw Failure(description: reply.text) }

    let tabs = try reply.data.decode(TabsResult.self).tabs
    return session.withLock { ($0.adopt(tabs), $0.visible(tabs)) }
  }

  /// Refuses tabs this session did not open, after adopting any new popups of its own tabs.
  static func requireOwned(_ tab: Int) async throws {
    if session.withLock({ $0.owned.contains(tab) }) { return }

    guard try await refresh().visible.contains(where: { $0.id == tab }) else { throw Failure(description: "tab \(tab) is not one of this session's tabs; tabs_list shows them and tab_create opens one") }
  }

  static func text(_ text: String) -> Tool.Content { .text(text: text, annotations: nil, _meta: nil) }

  /// Sends a command under this process's approved session, asking for approval first when there is none.
  /// A refused session (the app relaunched and forgot it, or the person disconnected it) is dropped, and the command, which never ran, is sent once more under a new one.
  private static func exchange(_ command: AppCommand) async throws -> CLIReply {
    let send = { (key: String) in try await blocking { try AppClient.send(command, timeout: CLIRequest.defaultTimeout, session: key) } }
    let key = try await approval.session()
    let reply = try await send(key)

    guard reply.data["unapproved"]?.bool == true else { return reply }

    await approval.drop(key)
    let renewed = try await approval.session()
    let retried = try await send(renewed)

    if retried.data["unapproved"]?.bool == true { await approval.drop(renewed) }

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
