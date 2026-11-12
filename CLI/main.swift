import Foundation

var arguments = Array(CommandLine.arguments.dropFirst())
let json = arguments.contains("--json")
arguments.removeAll { $0 == "--json" }
var timeout = CLIRequest.defaultTimeout

if let index = arguments.firstIndex(of: "--timeout") {
  guard index + 1 < arguments.count, let value = Double(arguments[index + 1]) else {
    FileHandle.standardError.write(Data("--timeout needs a number of seconds\n".utf8))
    exit(2)
  }

  timeout = value
  arguments.removeSubrange(index ... index + 1)
}

#if DEBUG
  let usage = CommandLineParsing.usage
#else
  let usage = "usage: safaripilot mcp|status\n\n  mcp     run as a stdio MCP server\n  status  app, extension and background state\n\nDev commands are in Debug builds: scripts/install.sh --debug"
#endif

if arguments.isEmpty || arguments == ["help"] || arguments == ["--help"] {
  print(usage)
  exit(arguments.isEmpty ? 2 : 0)
}

if arguments == ["mcp"] {
  do {
    try await MCPServer.run()
    exit(0)
  } catch {
    MCPServer.log("fatal: \(error)")
    exit(1)
  }
}

#if !DEBUG
  guard arguments == ["status"] else {
    FileHandle.standardError.write(Data("error: this build runs only mcp and status; dev commands are in Debug builds (scripts/install.sh --debug)\n".utf8))
    exit(2)
  }
#endif

do {
  let invocation = try CommandLineParsing.parse(arguments)
  var reply = try AppClient.send(invocation.command, timeout: timeout)

  if case .screenshot = invocation.command, reply.ok, let base64 = reply.data["png"]?.string, let png = Data(base64Encoded: base64) {
    let path = invocation.outputPath ?? "safaripilot-\(Int(Date.now.timeIntervalSince1970)).png"
    let url = URL(filePath: path, relativeTo: URL.currentDirectory()).standardizedFileURL
    try png.write(to: url)
    reply = CLIReply(ok: true, text: "\(reply.text)\nsaved \(url.path) (\(png.count) bytes)", data: .object(["path": .string(url.path), "bytes": .number(Double(png.count)), "tab": reply.data["tab"] ?? .null]))
  }

  if json {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try print(String(decoding: encoder.encode(reply), as: UTF8.self))
  } else {
    print(reply.ok ? reply.text : "error: \(reply.text)")
  }

  exit(reply.ok ? 0 : 1)
} catch {
  FileHandle.standardError.write(Data("error: \(error)\n".utf8))
  exit(1)
}
