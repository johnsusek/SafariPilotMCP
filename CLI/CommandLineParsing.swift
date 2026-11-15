import Foundation

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
    click TARGET                    locate TARGET, then AXPress it
      [--action double_click|triple_click|right_click] [--modifiers ctrl+shift+alt+cmd]  synthetic DOM events instead
    drag REF TO                     drag from REF to TO in one frame as synthetic DOM events
    form-input TARGET VALUE         set a text field, checkbox or radio (true|false), select option or color (#rrggbb)
    key KEYS [--ref REF] [--repeat N]  press space-separated keys in the page, focusing REF first
    key [--ref REF] --text TEXT     type TEXT one key per character
    events [--clear]                events the page logged since its first events read
    tabs                            all Safari tabs
    tab-create [URL]                open a tab in a new window
    tab-select ID                   make a tab active in its window
    tab-close ID                    close a tab
    navigate URL|back|forward       load a URL or walk history
    read-page [--all] [--max-chars N] [--ref REF] [--depth N]  element tree with refs
    find [NAME] [--role ROLE]       visible elements whose name contains NAME and role is ROLE
    text [--max-chars N]            readable page text
    wait-check --text TEXT | --selector SELECTOR  one look in every frame for shown text or a shown element (MCP wait repeats it)
    scroll up|down|left|right [STEPS] [--ref REF]  scroll by STEPS x 100 CSS px
    scroll-to TARGET                center TARGET in the view
    screenshot [PATH] [--region X0,Y0,X1,Y1] [--scale S]  save the tab as PNG
    resize WIDTH HEIGHT             resize the tab's window in points
    javascript [--frame REF] CODE   run CODE in the page's main world and print its last expression as JSON
    file-upload TARGET PATH...      give files to the file input TARGET (or the one it labels or holds), or drop them on TARGET
    console [--errors] [--pattern REGEX] [--limit N] [--clear]  console messages from every frame, newest N (default 50, up to 200)
    network [--pattern TEXT] [--limit N] [--clear] | --id ID  requests a tab_create tab made, newest N (default 50, up to 200), or one request's headers and bodies
    dialog accept|dismiss [--text TEXT]  press OK or Cancel on the tab's alert, confirm or prompt, typing TEXT into a prompt
    debug-ax [REF]                  AX windows and frames next to viewport metrics
    debug-frames                    each frame's content script, iframes and logged clicks and keydowns
    debug-cg key KEYS [--ref REF]   post a key press as CGEvents and report what the page logged
    debug-cg click|hover REF        the same for a click or a hover
    debug-cg drag FROM TO           the same for a drag
      --no-window-fields            leave window-under-pointer fields unset on mouse events
    mcp                             run as a stdio MCP server

  REF is 12, or 5:12 inside iframe 5's frame. TARGET is REF, or --name NAME and/or --role ROLE picking the one element find's rules match,
  an exact name winning; key and scroll take --name and --role in place of --ref too.
  Without --tab, commands act on the active tab of the last focused window.
  """

  static func parse(_ arguments: [String]) throws -> Invocation {
    var words = arguments
    let tabId = try option("--tab", &words).map { try integer($0, "--tab") }

    guard let name = words.first else { throw Failure(.invalidArgument, "missing command") }

    var rest = Array(words.dropFirst())
    let takesMaxChars = name == "read-page" || name == "text"
    let maxChars = try (takesMaxChars ? option("--max-chars", &rest) : nil).map { try integer($0, "--max-chars") } ?? AppCommand.defaultMaxChars
    var invocation: Invocation

    switch name {
    case "status": invocation = Invocation(command: .status)
    case "ping": invocation = Invocation(command: .ping(tabId: tabId))
    case "snapshot": invocation = Invocation(command: .snapshot(tabId: tabId))
    case "click":
      let action = try option("--action", &rest)
      let modifiers = try option("--modifiers", &rest)
      invocation = try Invocation(command: .click(tabId: tabId, target: leadingTarget(&rest), actionName: action, modifierNames: modifiers))
    case "drag":
      guard rest.count >= 2 else { throw Failure(.invalidArgument, "drag needs REF and TO") }

      invocation = try Invocation(command: .drag(tabId: tabId, ref: ref(rest[0], "REF"), to: ref(rest[1], "TO")))
    case "events": invocation = Invocation(command: .events(tabId: tabId, clear: flag("--clear", &rest)))
    case "tabs": invocation = Invocation(command: .tabs)
    case "tab-create": invocation = Invocation(command: .tabCreate(url: rest.first))
    case "tab-select": invocation = try Invocation(command: .tabSelect(tabId: integer(rest.first, "ID")))
    case "tab-close": invocation = try Invocation(command: .tabClose(tabId: integer(rest.first, "ID")))
    case "read-page":
      let ref = try option("--ref", &rest).map { try Self.ref($0, "--ref") }
      let depth = try option("--depth", &rest).map { try integer($0, "--depth") }
      invocation = try Invocation(command: .readPage(tabId: tabId, filter: flag("--all", &rest) ? .all : .interactive, maxChars: maxChars, root: ref, depth: depth))
    case "scroll-to": invocation = try Invocation(command: .scrollTo(tabId: tabId, target: leadingTarget(&rest)))
    case "resize":
      guard rest.count == 2 else { throw Failure(.invalidArgument, "resize needs WIDTH and HEIGHT") }

      invocation = try Invocation(command: .resize(tabId: tabId, width: integer(rest[0], "WIDTH"), height: integer(rest[1], "HEIGHT")))
    case "text": invocation = Invocation(command: .pageText(tabId: tabId, maxChars: maxChars))
    case "console":
      let pattern = try option("--pattern", &rest)
      let limit = try option("--limit", &rest).map { try integer($0, "--limit") }
      invocation = try Invocation(command: .console(tabId: tabId, onlyErrors: flag("--errors", &rest), pattern: pattern, limit: limit, clear: flag("--clear", &rest)))
    case "network":
      let requestId = try option("--id", &rest)
      let pattern = try option("--pattern", &rest)
      let limit = try option("--limit", &rest).map { try integer($0, "--limit") }
      invocation = try Invocation(command: .network(tabId: tabId, requestId: requestId, urlPattern: pattern, limit: limit, clear: flag("--clear", &rest)))
    case "dialog":
      // --text takes every word after it verbatim.
      let textStart = rest.firstIndex(of: "--text")
      let text = textStart.map { rest[($0 + 1)...].joined(separator: " ") }

      if let textStart { rest.removeSubrange(textStart...) }

      invocation = try Invocation(command: .dialog(tabId: tabId, action: rest.first ?? "missing", promptText: text))
    case "screenshot":
      let region = try option("--region", &rest).map { text in
        try text.split(separator: ",").map { word in
          guard let number = Double(word) else { throw Failure(.invalidArgument, "--region must be X0,Y0,X1,Y1, not \(text)") }
          return number
        }
      }
      let scale = try option("--scale", &rest).map { text in
        guard let number = Double(text) else { throw Failure(.invalidArgument, "--scale must be a number, not \(text)") }
        return number
      }
      invocation = try Invocation(command: .screenshot(tabId: tabId, corners: region, scale: scale), outputPath: rest.first)
    case "debug-frames": invocation = Invocation(command: .debugFrames(tabId: tabId))
    case "debug-ax": invocation = try Invocation(command: .debugAX(tabId: tabId, ref: rest.first.map { try Self.ref($0, "REF") }))
    case "debug-cg":
      let windowFields = !flag("--no-window-fields", &rest)
      let ref = try option("--ref", &rest).map { try Self.ref($0, "--ref") }
      let probe = try probe(rest, ref: ref)

      if !windowFields, probe.isKey { throw Failure(.invalidArgument, "--no-window-fields applies only to mouse actions") }

      invocation = Invocation(command: .debugCG(tabId: tabId, probe: probe, windowFields: windowFields))
    case "form-input":
      let target = try leadingTarget(&rest)

      guard !rest.isEmpty else { throw Failure(.invalidArgument, "form-input needs TARGET and VALUE") }

      // Free text is taken verbatim, so it skips the stray option check below.
      return Invocation(command: .formInput(tabId: tabId, target: target, value: .text(rest.joined(separator: " "))))
    case "javascript":
      let frame = try rest.first == "--frame" ? option("--frame", &rest).map { try Self.ref($0, "--frame") } : nil

      // CODE is taken verbatim, so it skips the stray option check below.
      return try Invocation(command: .javascript(tabId: tabId, text: rest.joined(separator: " "), frame: frame))
    case "file-upload":
      let target = try leadingTarget(&rest)

      guard !rest.isEmpty else { throw Failure(.invalidArgument, "file-upload needs TARGET and at least one PATH") }

      // Paths are taken verbatim, relative ones from the current directory, so they skip the stray option check below.
      let paths = rest.map { URL(filePath: $0, relativeTo: URL.currentDirectory()).standardizedFileURL.path }
      return try Invocation(command: .fileUpload(tabId: tabId, target: target, paths: paths))
    case "find":
      let role = try option("--role", &rest) ?? ""
      let name = rest.joined(separator: " ")

      guard !name.isEmpty || !role.isEmpty else { throw Failure(.invalidArgument, "find needs a NAME or --role") }

      // NAME is free text, so it skips the stray option check below.
      return Invocation(command: .find(tabId: tabId, name: name, role: role))
    case "wait-check":
      guard let kind = rest.first, ["--text", "--selector"].contains(kind) else { throw Failure(.invalidArgument, "wait-check needs --text TEXT or --selector SELECTOR") }

      // The value is every word after its option, verbatim, so it skips the stray option check below.
      let value = rest.dropFirst().joined(separator: " ")
      return try Invocation(command: .waitCheck(tabId: tabId, condition: WaitCondition(text: kind == "--text" ? value : nil, selector: kind == "--selector" ? value : nil)))
    case "navigate":
      guard let target = rest.first else { throw Failure(.invalidArgument, "navigate needs a URL, back or forward") }

      invocation = Invocation(command: .navigation(tabId: tabId, target: target))
    case "key":
      // --text takes every word after it verbatim, so it is split off before the options are read.
      let textStart = rest.firstIndex(of: "--text")
      let text = textStart.map { rest[($0 + 1)...].joined(separator: " ") }

      if let textStart { rest.removeSubrange(textStart...) }

      let target = try optionalTarget(&rest)
      let times = try option("--repeat", &rest).map { try integer($0, "--repeat") } ?? 1
      let keys = text != nil && rest.isEmpty ? nil : rest.joined(separator: " ")
      invocation = try Invocation(command: .key(tabId: tabId, keys: keys, text: text, target: target, times: times))
    case "scroll":
      let target = try optionalTarget(&rest)

      guard let direction = rest.first else { throw Failure(.invalidArgument, "scroll needs a direction: up, down, left or right") }

      let stepsText = rest.dropFirst().first ?? "3"

      guard let steps = Double(stepsText) else { throw Failure(.invalidArgument, "STEPS must be a number, not \(stepsText)") }

      invocation = try Invocation(command: .scroll(tabId: tabId, target: target, direction: direction, amount: steps))
    default:
      throw Failure(.invalidArgument, "unknown command \(name)")
    }

    if let stray = rest.first(where: { $0.hasPrefix("--") }) { throw Failure(.invalidArgument, "unknown option \(stray) for \(name)") }

    return invocation
  }

  private static func probe(_ words: [String], ref: PageRef?) throws -> CGProbe {
    let action = words.first ?? "missing"
    let arguments = Array(words.dropFirst())
    let arity = ["key": 1, "click": 1, "hover": 1, "drag": 2]

    guard let expected = arity[action] else { throw Failure(.invalidArgument, "debug-cg action must be key, click, hover or drag, not \(action)") }
    guard arguments.count == expected else { throw Failure(.invalidArgument, "debug-cg \(action) takes \(expected) argument\(expected == 1 ? "" : "s"), got \(arguments.count)") }

    if ref != nil, action != "key" { throw Failure(.invalidArgument, "--ref applies only to debug-cg key") }

    switch action {
    case "key": return try .key(KeyChord.parse(arguments[0]), ref: ref)
    case "click": return try .click(ref: Self.ref(arguments[0], "REF"))
    case "hover": return try .hover(ref: Self.ref(arguments[0], "REF"))
    default: return try .drag(from: Self.ref(arguments[0], "FROM"), to: Self.ref(arguments[1], "TO"))
    }
  }

  /// REF as the first word, or --name NAME and --role ROLE in either order at the front, removed from words.
  private static func leadingTarget(_ words: inout [String]) throws -> ElementTarget {
    var named: [String: String] = [:]

    while let first = words.first, ["--name", "--role"].contains(first) {
      guard words.count > 1 else { throw Failure(.invalidArgument, "\(first) needs a value") }
      guard named[first] == nil else { throw Failure(.invalidArgument, "\(first) repeated") }

      named[first] = words[1]
      words.removeFirst(2)
    }

    if let target = try ElementTarget.from(ref: nil, name: named["--name"], role: named["--role"]) { return target }

    let target = try ElementTarget.ref(ref(words.first, "TARGET"))
    words.removeFirst()
    return target
  }

  /// --ref REF, or --name NAME and --role ROLE, anywhere in words; nil when none is given.
  private static func optionalTarget(_ words: inout [String]) throws -> ElementTarget? {
    let ref = try option("--ref", &words).map { try Self.ref($0, "--ref") }
    return try ElementTarget.from(ref: ref, name: option("--name", &words), role: option("--role", &words))
  }

  /// Removes `name VALUE` from words and returns VALUE.
  private static func option(_ name: String, _ words: inout [String]) throws -> String? {
    guard let index = words.firstIndex(of: name) else { return nil }
    guard index + 1 < words.count else { throw Failure(.invalidArgument, "\(name) needs a value") }

    let value = words[index + 1]
    words.removeSubrange(index ... index + 1)
    return value
  }

  private static func flag(_ name: String, _ words: inout [String]) -> Bool {
    guard let index = words.firstIndex(of: name) else { return false }

    words.remove(at: index)
    return true
  }

  private static func ref(_ text: String?, _ name: String) throws -> PageRef {
    guard let text else { throw Failure(.invalidArgument, "\(name) is missing") }
    return try PageRef(parsing: text)
  }

  private static func integer(_ text: String?, _ name: String) throws -> Int {
    guard let text, let value = Int(text) else { throw Failure(.invalidArgument, "\(name) must be an integer, not \(text ?? "missing")") }
    return value
  }
}
