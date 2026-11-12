/// CLI to app: the app does the work and returns both readable text and structured data.
struct CLIRequest: Codable, Sendable {
  var kind = "cli"
  let command: String
  let args: [String]
  let timeoutSeconds: Double
}

struct CLIReply: Codable, Sendable {
  let ok: Bool
  let text: String
  let data: JSONValue
}
