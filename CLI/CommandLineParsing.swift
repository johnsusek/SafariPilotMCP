/// A parsed CLI invocation; outputPath is where screenshot writes its PNG.
struct Invocation: Equatable {
  let command: AppCommand
  var outputPath: String?
}

enum CommandLineParsing {
  static let usage = """
  usage: safaripilot [--json] [--timeout SECONDS] [--tab ID] COMMAND [ARGS]

    status                          app, extension and background state
    ping                            title and URL of the tab
    snapshot                        interactive elements with refs
    click REF                       locate REF, then AXPress it
    type REF TEXT                   locate REF, then AXFocused + AXValue
    key KEYS [--ref REF] [--repeat N]  press space-separated keys in the page, focusing REF first
    events [--clear]                events logged by the page
    tabs                            all Safari tabs
    tab-create [URL]                open a tab in the last focused window
    tab-select ID                   make a tab active in its window
    tab-close ID                    close a tab
    navigate URL|back|forward       load a URL or walk history
    read-page [--all] [--max-chars N]  element tree with refs
    find [NAME] [--role ROLE]       visible elements whose name contains NAME and role is ROLE
    text [--max-chars N]            readable page text
    scroll up|down|left|right [STEPS] [--ref REF]  scroll by STEPS x 100 CSS px
    screenshot [PATH]               save the tab as PNG
    debug-ax [REF]                  AX windows and frames next to viewport metrics
    debug-cg key KEYS [--ref REF]   post a key press as CGEvents and report what the page logged
    debug-cg click|hover REF        the same for a click or a hover
    debug-cg drag FROM TO           the same for a drag
      --no-window-fields            leave window-under-pointer fields unset on mouse events
    mcp                             run as a stdio MCP server

  Without --tab, commands act on the active tab of the last focused window.
  """

  static func parse(_ arguments: [String]) throws -> Invocation {
    var words = arguments
    let tabId = try option("--tab", &words).map { try integer($0, "--tab") }

    guard let name = words.first else { throw Failure(description: "missing command") }

    var rest = Array(words.dropFirst())
    let takesMaxChars = name == "read-page" || name == "text"
    let maxChars = try (takesMaxChars ? option("--max-chars", &rest) : nil).map { try integer($0, "--max-chars") } ?? AppCommand.defaultMaxChars
    var invocation: Invocation

    switch name {
    case "status": invocation = Invocation(command: .status)
    case "ping": invocation = Invocation(command: .ping(tabId: tabId))
    case "snapshot": invocation = Invocation(command: .snapshot(tabId: tabId))
    case "click": invocation = try Invocation(command: .click(tabId: tabId, ref: integer(rest.first, "REF")))
    case "events": invocation = Invocation(command: .events(tabId: tabId, clear: flag("--clear", &rest)))
    case "tabs": invocation = Invocation(command: .tabs)
    case "tab-create": invocation = Invocation(command: .tabCreate(url: rest.first))
    case "tab-select": invocation = try Invocation(command: .tabSelect(tabId: integer(rest.first, "ID")))
    case "tab-close": invocation = try Invocation(command: .tabClose(tabId: integer(rest.first, "ID")))
    case "read-page": invocation = Invocation(command: .readPage(tabId: tabId, filter: flag("--all", &rest) ? .all : .interactive, maxChars: maxChars))
    case "text": invocation = Invocation(command: .pageText(tabId: tabId, maxChars: maxChars))
    case "screenshot": invocation = Invocation(command: .screenshot(tabId: tabId), outputPath: rest.first)
    case "debug-ax": invocation = try Invocation(command: .debugAX(tabId: tabId, ref: rest.first.map { try integer($0, "REF") }))
    case "debug-cg":
      let windowFields = !flag("--no-window-fields", &rest)
      let ref = try option("--ref", &rest).map { try integer($0, "--ref") }
      let probe = try probe(rest, ref: ref)

      if !windowFields, probe.isKey { throw Failure(description: "--no-window-fields applies only to mouse actions") }

      invocation = Invocation(command: .debugCG(tabId: tabId, probe: probe, windowFields: windowFields))
    case "type":
      guard rest.count >= 2 else { throw Failure(description: "type needs REF and TEXT") }

      // Free text is taken verbatim, so it skips the stray option check below.
      return try Invocation(command: .type(tabId: tabId, ref: integer(rest[0], "REF"), text: rest.dropFirst().joined(separator: " ")))
    case "find":
      let role = try option("--role", &rest) ?? ""
      let name = rest.joined(separator: " ")

      guard !name.isEmpty || !role.isEmpty else { throw Failure(description: "find needs a NAME or --role") }

      // NAME is free text, so it skips the stray option check below.
      return Invocation(command: .find(tabId: tabId, name: name, role: role))
    case "navigate":
      guard let target = rest.first else { throw Failure(description: "navigate needs a URL, back or forward") }

      invocation = Invocation(command: .navigation(tabId: tabId, target: target))
    case "key":
      let ref = try option("--ref", &rest).map { try integer($0, "--ref") }
      let times = try option("--repeat", &rest).map { try integer($0, "--repeat") } ?? 1
      invocation = try Invocation(command: .key(tabId: tabId, keys: rest.joined(separator: " "), ref: ref, times: times))
    case "scroll":
      let ref = try option("--ref", &rest).map { try integer($0, "--ref") }

      guard let direction = rest.first else { throw Failure(description: "scroll needs a direction: up, down, left or right") }

      let stepsText = rest.dropFirst().first ?? "3"

      guard let steps = Double(stepsText) else { throw Failure(description: "STEPS must be a number, not \(stepsText)") }

      invocation = try Invocation(command: .scroll(tabId: tabId, ref: ref, direction: direction, amount: steps))
    default:
      throw Failure(description: "unknown command \(name)")
    }

    if let stray = rest.first(where: { $0.hasPrefix("--") }) { throw Failure(description: "unknown option \(stray) for \(name)") }

    return invocation
  }

  private static func probe(_ words: [String], ref: Int?) throws -> CGProbe {
    let action = words.first ?? "missing"
    let arguments = Array(words.dropFirst())
    let arity = ["key": 1, "click": 1, "hover": 1, "drag": 2]

    guard let expected = arity[action] else { throw Failure(description: "debug-cg action must be key, click, hover or drag, not \(action)") }
    guard arguments.count == expected else { throw Failure(description: "debug-cg \(action) takes \(expected) argument\(expected == 1 ? "" : "s"), got \(arguments.count)") }

    if ref != nil, action != "key" { throw Failure(description: "--ref applies only to debug-cg key") }

    switch action {
    case "key": return try .key(KeyChord.parse(arguments[0]), ref: ref)
    case "click": return try .click(ref: integer(arguments[0], "REF"))
    case "hover": return try .hover(ref: integer(arguments[0], "REF"))
    default: return try .drag(from: integer(arguments[0], "FROM"), to: integer(arguments[1], "TO"))
    }
  }

  /// Removes `name VALUE` from words and returns VALUE.
  private static func option(_ name: String, _ words: inout [String]) throws -> String? {
    guard let index = words.firstIndex(of: name) else { return nil }
    guard index + 1 < words.count else { throw Failure(description: "\(name) needs a value") }

    let value = words[index + 1]
    words.removeSubrange(index ... index + 1)
    return value
  }

  private static func flag(_ name: String, _ words: inout [String]) -> Bool {
    guard let index = words.firstIndex(of: name) else { return false }

    words.remove(at: index)
    return true
  }

  private static func integer(_ text: String?, _ name: String) throws -> Int {
    guard let text, let value = Int(text) else { throw Failure(description: "\(name) must be an integer, not \(text ?? "missing")") }
    return value
  }
}
