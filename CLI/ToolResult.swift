/// One tool call's result before it becomes an MCP result: text and PNG images in order, and on a failure its code and, in browser_batch, the step that failed.
struct ToolResult: Equatable, Sendable {
  enum Item: Equatable, Sendable {
    case text(String)
    case png(String)
  }

  var items: [Item]
  var code: ErrorCode?
  var step: Int?

  static func text(_ text: String) -> ToolResult { ToolResult(items: [.text(text)]) }

  static func failed(_ error: any Error) -> ToolResult { ToolResult(items: [.text("\(error)")], code: ErrorCode(of: error)) }

  /// A reply from the app; one with no code, from an app older than this server, counts as failed.
  static func reply(_ reply: CLIReply) -> ToolResult { ToolResult(items: [.text(reply.text)], code: reply.ok ? nil : reply.code ?? .failed) }

  var ok: Bool { code == nil }

  var message: String {
    items.compactMap { item in
      guard case let .text(text) = item else { return nil }
      return text
    }.joined(separator: "\n")
  }

  /// The last line of every failed result, in a fixed format a model reads, since most clients show it only the text.
  var errorLine: String? {
    guard let code else { return nil }

    return "error code=\(code.rawValue) retryable=\(code.retryable) next=\(code.next.rawValue)\(step.map { " step=\($0)" } ?? "")"
  }

  /// The items as sent: a failure's error line ends its last text block.
  var shown: [Item] {
    guard let errorLine else { return items }
    guard case let .text(last)? = items.last else { return items + [.text(errorLine)] }

    return items.dropLast() + [.text("\(last)\n\(errorLine)")]
  }

  /// The error line's fields with the message, for clients that read structuredContent; nil on success.
  var structured: JSONValue? {
    guard let code else { return nil }

    var fields: [String: JSONValue] = ["code": .string(code.rawValue), "retryable": .bool(code.retryable), "next": .string(code.next.rawValue), "message": .string(message)]
    fields["step"] = step.map { .number(Double($0)) }
    return .object(fields)
  }

  /// Reads whose failure leaves the page as it was; wait is left out, since the steps after it count on what it waited for.
  static let reads: Set = ["get_page_text", "read_page", "find", "screenshot", "tabs_list", "read_console_messages", "read_network_requests"]

  /// Runs browser_batch's actions in order, labeling each one's output. A failed read, or javascript a page's policy refused to run, changed nothing,
  /// so the batch goes on past it; any other failure stops it. The result carries the code and number of the step that stopped it, else of the first
  /// failure. Text between images is merged into one block joined by line breaks, since clients concatenate blocks with no separator.
  static func batch(_ actions: [(name: String, input: [String: JSONValue])], run: (String, [String: JSONValue]) async -> ToolResult) async -> ToolResult {
    var items: [Item] = []
    var lines: [String] = []
    var failure: (code: ErrorCode, step: Int)?

    func flush() {
      if !lines.isEmpty { items.append(.text(lines.joined(separator: "\n"))) }

      lines = []
    }

    for (index, action) in actions.enumerated() {
      let result = await run(action.name, action.input)
      lines.append("\(index + 1)/\(actions.count) \(action.name)\(result.ok ? "" : " failed"):")

      for item in result.items {
        if case let .text(body) = item {
          lines.append(body)
          continue
        }

        flush()
        items.append(item)
      }

      guard let code = result.code else { continue }

      if reads.contains(action.name) || (action.name == "javascript" && code == .notActionable) {
        failure = failure ?? (code, index + 1)
        continue
      }

      lines.append("stopped after \(index + 1) of \(actions.count) actions")
      flush()
      return ToolResult(items: items, code: code, step: index + 1)
    }

    flush()
    return ToolResult(items: items, code: failure?.code, step: failure?.step)
  }
}
