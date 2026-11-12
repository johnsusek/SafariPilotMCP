import Foundation

let usage = """
usage: safaripilot [--json] [--timeout SECONDS] COMMAND [ARGS]

  status                 app, extension and background state
  ping                   title and URL of the target tab
  snapshot               interactive elements with refs
  click REF              locate REF, then AXPress it
  type REF TEXT          locate REF, then AXFocused + AXValue
  events [--clear]       events logged by the page
  tabs                   all Safari tabs
  navigate URL           load URL in the target tab
  screenshot [PATH]      save the visible tab as PNG
  debug-ax [REF]         AX frames next to viewport metrics
"""

var arguments = Array(CommandLine.arguments.dropFirst())
let json = arguments.contains("--json")
arguments.removeAll { $0 == "--json" }
var timeout = 20.0

if let index = arguments.firstIndex(of: "--timeout") {
  guard index + 1 < arguments.count, let value = Double(arguments[index + 1]) else {
    FileHandle.standardError.write(Data("--timeout needs a number of seconds\n".utf8))
    exit(2)
  }

  timeout = value
  arguments.removeSubrange(index ... index + 1)
}

guard let command = arguments.first, command != "help", command != "--help" else {
  print(usage)
  exit(arguments.isEmpty ? 2 : 0)
}

var args = Array(arguments.dropFirst())

if command == "screenshot" {
  let path = args.first ?? "safaripilot-\(Int(Date.now.timeIntervalSince1970)).png"
  args = [URL(filePath: path, relativeTo: URL.currentDirectory()).standardizedFileURL.path]
}

do {
  let request = try JSONEncoder().encode(CLIRequest(command: command, args: args, timeoutSeconds: timeout))
  let replyData = try Wire.exchange(request, timeoutSeconds: Int(timeout) + 15)
  let reply = try JSONDecoder().decode(CLIReply.self, from: replyData)

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
