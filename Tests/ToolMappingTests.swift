import Foundation
import Testing

struct ToolMappingTests {
  func map(_ name: String, _ arguments: [String: JSONValue] = [:], session: Int? = 20) throws -> AppCommand { try Tools.command(name: name, arguments: arguments, session: TabSession(owned: Set(session.map { [$0] } ?? []), current: session)) }

  @Test func everyToolMapsWithItsRequiredArguments() throws {
    let file = FileManager.default.temporaryDirectory.appending(path: "sample-\(UUID().uuidString).txt")
    try Data("sample".utf8).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    let samples: [String: JSONValue] = ["tabId": .number(7), "url": "https://example.com", "name": "Sign in", "ref": .number(3), "value": "hello", "direction": "down", "width": .number(800), "height": .number(600), "text": "document.title", "action": "accept", "paths": .array([.string(file.path)])]

    // key needs keys or text but neither is required by itself; browser_batch and wait run in MCPServer, not through command.
    for tool in Tools.definitions where !["browser_batch", "wait"].contains(tool.name) {
      let arguments = samples.filter { tool.required.contains($0.key) }.merging(tool.name == "key" ? ["keys": "Enter"] : [:]) { $1 }
      #expect(throws: Never.self) { try map(tool.name, arguments) }
    }
  }

  @Test func descriptionsAreOneSentence() {
    for tool in Tools.definitions {
      #expect(tool.description.hasSuffix("."), "\(tool.name)")
      #expect(tool.description.dropLast().contains(". ") == false, "\(tool.name)")
    }
  }

  @Test func pageToolsAcceptTabId() {
    let tabless: Set = ["tabs_list", "tab_create", "browser_batch", "wait"]

    for tool in Tools.definitions where !tabless.contains(tool.name) {
      #expect(tool.properties["tabId"] != nil, "\(tool.name)")
    }
  }

  @Test func schemaListsRequiredKeys() {
    let schema = Tools.definitions.first { $0.name == "form_input" }!.inputSchema
    #expect(schema["type"] == "object")
    #expect(schema["required"] == .array(["ref", "value"]))
  }

  @Test func refsAreTopFrameNumbersOrFramePaths() throws {
    #expect(try map("click", ["ref": .number(12)]) == .click(tabId: 20, ref: 12))
    #expect(try map("click", ["ref": "12"]) == .click(tabId: 20, ref: 12))
    #expect(try map("click", ["ref": "5:12"]) == .click(tabId: 20, ref: PageRef(frames: [5], local: 12)))
    #expect(try map("scroll_to", ["ref": "5:3:12"]) == .scrollTo(tabId: 20, ref: PageRef(frames: [5, 3], local: 12)))
    #expect(try map("read_page", ["ref_id": "5:2"]) == .readPage(tabId: 20, filter: .all, maxChars: AppCommand.defaultMaxChars, ref: PageRef(frames: [5], local: 2), depth: nil))
    #expect(throws: Failure.self) { try map("click", ["ref": .number(5.12)]) }
    #expect(throws: Failure.self) { try map("click", ["ref": "5.12"]) }
    #expect(throws: Failure.self) { try map("click", ["ref": "1:2:3:4:5"]) }
    #expect(throws: Failure.self) { try map("click", ["ref": "5:"]) }
    #expect(try CommandLineParsing.parse(["click", "5:3:12"]).command == .click(tabId: nil, ref: PageRef(frames: [5, 3], local: 12)))
    #expect(throws: Failure.self) { try CommandLineParsing.parse(["click", "5.12"]) }
  }

  @Test func clickTakesActionAndModifiers() throws {
    #expect(try map("click", ["ref": .number(4), "action": "left_click", "modifiers": ""]) == .click(tabId: 20, ref: 4))
    #expect(try map("click", ["ref": .number(4), "action": "double_click"]) == .click(tabId: 20, ref: 4, action: .double))
    #expect(try map("click", ["ref": .number(4), "action": "triple_click"]) == .click(tabId: 20, ref: 4, action: .triple))
    #expect(try map("click", ["ref": "5:12", "action": "right_click", "modifiers": "ctrl+shift"]) == .click(tabId: 20, ref: PageRef(frames: [5], local: 12), action: .right, modifiers: [.shift, .ctrl]))
    #expect(try map("click", ["ref": .number(4), "modifiers": "alt+Meta"]) == .click(tabId: 20, ref: 4, action: .left, modifiers: [.cmd, .alt]))
    let click = Tools.definitions.first { $0.name == "click" }!
    #expect(click.properties["action"]?["enum"] == .array(["left_click", "double_click", "triple_click", "right_click"]))
    #expect(click.properties["modifiers"]?["type"] == "string")
  }

  @Test func clickRefusesBadActionsAndModifiers() throws {
    let bad: [[String: JSONValue]] = [["action": "middle_click"], ["action": .number(2)], ["modifiers": "shift+win"], ["modifiers": "cmd+meta"], ["modifiers": .array(["shift"])]]

    for arguments in bad {
      #expect(throws: Failure.self, "\(arguments)") { try map("click", arguments.merging(["ref": .number(4)]) { $1 }) }
    }
  }

  @Test func clickActionAndModifiersCrossTheWire() throws {
    let command = AppCommand.click(tabId: 3, ref: PageRef(frames: [5], local: 2), action: .right, modifiers: [.cmd, .alt])
    #expect(try JSONDecoder().decode(AppCommand.self, from: JSONEncoder().encode(command)) == command)
    #expect(command.targetTab == 3)
  }

  @Test func refSchemaTakesIntegerOrString() {
    let click = Tools.definitions.first { $0.name == "click" }!
    #expect(click.properties["ref"]?["type"] == .array(["integer", "string"]))
  }

  @Test func omittedTabIdUsesTheSessionTab() throws {
    #expect(try map("click", ["ref": .number(4)]) == .click(tabId: 20, ref: 4))
    #expect(try map("get_page_text") == .pageText(tabId: 20, maxChars: AppCommand.defaultMaxChars))
    #expect(try map("screenshot", ["tabId": .null]) == .screenshot(tabId: 20, region: nil, scale: 1))
  }

  @Test func tabCreateUsesTheSessionWindow() throws {
    let session = TabSession(owned: [20], current: 20, window: 4)
    #expect(try Tools.command(name: "tab_create", arguments: [:], session: session) == .tabCreate(url: nil, windowId: 4))
  }

  @Test func tierOneToolsMap() throws {
    #expect(try map("scroll_to", ["ref": .number(9)]) == .scrollTo(tabId: 20, ref: 9))
    #expect(try map("resize_window", ["width": .number(1200), "height": .number(800)]) == .resizeWindow(tabId: 20, width: 1200, height: 800))
    #expect(try map("read_page", ["ref_id": .number(5), "depth": .number(2)]) == .readPage(tabId: 20, filter: .all, maxChars: AppCommand.defaultMaxChars, ref: 5, depth: 2))
    #expect(try map("screenshot", ["region": .array([.number(10), .number(20), .number(110.4), .number(220)]), "scale": .number(0.5)]) == .screenshot(tabId: 20, region: PixelRect(x0: 10, y0: 20, x1: 110, y1: 220), scale: 0.5))
    #expect(try Tools.waitSeconds(["seconds": .number(2.5)]) == 2.5)
  }

  @Test func tierOneToolsRefuseBadArguments() {
    let bad: [(String, [String: JSONValue])] = [
      ("read_page", ["depth": .number(0)]),
      ("screenshot", ["scale": .number(2)]),
      ("screenshot", ["region": .array([.number(10), .number(20), .number(5), .number(220)])]),
      ("screenshot", ["region": .array([.number(10), .number(20)])]),
      ("resize_window", ["width": .number(0), "height": .number(800)]),
    ]

    for (name, arguments) in bad { #expect(throws: Failure.self, "\(name) \(arguments)") { try map(name, arguments) } }

    #expect(throws: Failure.self) { try Tools.waitSeconds(["seconds": .number(11)]) }
  }

  @Test func handleDialogMapsAcceptOrDismiss() throws {
    #expect(try map("handle_dialog", ["action": "accept"]) == .dialog(tabId: 20, accept: true, promptText: nil))
    #expect(try map("handle_dialog", ["action": "dismiss", "tabId": .number(3)]) == .dialog(tabId: 3, accept: false, promptText: nil))
    #expect(try map("handle_dialog", ["action": "accept", "prompt_text": "Ada"]) == .dialog(tabId: 20, accept: true, promptText: "Ada"))
    #expect(throws: Failure.self) { try map("handle_dialog", ["action": "ok"]) }
    #expect(throws: Failure.self) { try map("handle_dialog") }
    #expect(try CommandLineParsing.parse(["dialog", "accept", "--text", "two", "words"]).command == .dialog(tabId: nil, accept: true, promptText: "two words"))
    #expect(try CommandLineParsing.parse(["--tab", "4", "dialog", "dismiss"]).command == .dialog(tabId: 4, accept: false, promptText: nil))
    #expect(throws: Failure.self) { try CommandLineParsing.parse(["dialog"]) }
  }

  @Test func findTakesNameAndRole() throws {
    #expect(try map("find", ["name": "Search", "role": "searchbox"]) == .find(tabId: 20, name: "Search", role: "searchbox"))
    #expect(try map("find", ["role": "link"]) == .find(tabId: 20, name: "", role: "link"))
  }

  @Test func explicitTabIdWins() throws {
    #expect(try map("click", ["ref": .number(4), "tabId": .number(3)]) == .click(tabId: 3, ref: 4))
    #expect(try map("click", ["ref": .number(4), "tabId": .number(3)], session: nil) == .click(tabId: 3, ref: 4))
  }

  @Test func pageToolsWithoutAnyTabFail() throws {
    for name in ["click", "form_input", "key", "find", "read_page", "get_page_text", "scroll", "scroll_to", "screenshot", "resize_window", "navigate"] {
      #expect("\(name)") {
        try map(name, ["ref": .number(1), "value": "x", "keys": "Enter", "name": "q", "direction": "down", "url": "back", "width": .number(800), "height": .number(600)], session: nil)
      } throws: { error in
        (error as? Failure)?.description == TabSession.noCurrent
      }
    }

    #expect(try map("tabs_list", session: nil) == .tabs)
    #expect(try map("tab_create", session: nil) == .tabCreate(url: nil, windowId: nil))
  }

  @Test func sessionFollowsTabCreateAndClose() {
    let created = CLIReply(ok: true, text: "", data: .object(["ok": .bool(true), "tab": .object(["id": .number(31), "windowId": .number(4)])]))
    let failed = CLIReply(ok: false, text: "", data: .object(["error": "no"]))
    let closed = CLIReply(ok: true, text: "", data: .object(["ok": .bool(true), "closed": .number(31)]))
    var session = TabSession(owned: [8], current: 8)
    session.record(.tabCreate(url: nil, windowId: nil), reply: failed)
    #expect(session == TabSession(owned: [8], current: 8))
    session.record(.tabCreate(url: nil, windowId: nil), reply: created)
    #expect(session == TabSession(owned: [8, 31], current: 31, window: 4))
    session.record(.click(tabId: 8, ref: 1), reply: created)
    #expect(session == TabSession(owned: [8, 31], current: 31, window: 4))
    session.record(.tabClose(tabId: 8), reply: closed)
    #expect(session == TabSession(owned: [31], current: 31, window: 4))
    session.record(.tabClose(tabId: 31), reply: closed)
    #expect(session == TabSession(owned: [], current: nil, window: 4))
  }

  func tab(_ id: Int, opener: Int? = nil) -> TabInfo { TabInfo(id: id, windowId: 1, active: false, url: "https://\(id).test/", title: "", windowFrame: nil, openerId: opener) }

  @Test func adoptsPopupsOfOwnedTabsTransitively() {
    var session = TabSession(owned: [5], current: 5)
    let tabs = [tab(1), tab(5, opener: 1), tab(7, opener: 9), tab(9, opener: 5), tab(3, opener: 2)]
    #expect(session.adopt(tabs).map(\.id).sorted() == [7, 9])
    #expect(session.visible(tabs).map(\.id) == [5, 7, 9])
    #expect(session.adopt(tabs).isEmpty)
  }

  @Test func adoptForgetsClosedTabs() {
    var session = TabSession(owned: [5, 6], current: 5)
    _ = session.adopt([tab(6)])
    #expect(session == TabSession(owned: [6], current: nil))
  }

  @Test func commandsNameTheirTargetTab() {
    #expect(AppCommand.click(tabId: 4, ref: 1).targetTab == 4)
    #expect(AppCommand.tabClose(tabId: 6).targetTab == 6)
    #expect(AppCommand.tabs.targetTab == nil)
    #expect(AppCommand.tabCreate(url: nil, windowId: nil).targetTab == nil)
  }

  @Test func integersAcceptDigitStrings() throws {
    #expect(try map("form_input", ["tabId": "12", "ref": .number(5), "value": "abc"]) == .formInput(tabId: 12, ref: 5, value: .text("abc")))
  }

  @Test func wrongTypesFailLoudly() {
    #expect(throws: Failure.self) { try map("click", ["ref": .number(1.5)]) }
    #expect(throws: Failure.self) { try map("click", ["ref": .bool(true)]) }
    #expect(throws: Failure.self) { try map("click") }
    #expect(throws: Failure.self) { try map("tab_select") }
    #expect(throws: Failure.self) { try map("read_page", ["filter": "visible"]) }
  }

  @Test func formInputValueTypes() throws {
    #expect(try map("form_input", ["ref": .number(5), "value": .bool(true)]) == .formInput(tabId: 20, ref: 5, value: .checked(true)))
    #expect(try map("form_input", ["ref": .number(5), "value": .number(42)]) == .formInput(tabId: 20, ref: 5, value: .text("42")))
    #expect(try map("form_input", ["ref": .number(5), "value": .number(1.5)]) == .formInput(tabId: 20, ref: 5, value: .text("1.5")))
    #expect(try map("form_input", ["ref": .number(5), "value": ""]) == .formInput(tabId: 20, ref: 5, value: .text("")))
    #expect(throws: Failure.self) { try map("form_input", ["ref": .number(5)]) }
    #expect(throws: Failure.self) { try map("form_input", ["ref": .number(5), "value": .array([])]) }
  }

  @Test func batchActionsParse() throws {
    let actions = try Tools.batchActions(["actions": .array([
      .object(["name": "click", "input": .object(["ref": .number(3)])]),
      .object(["name": "tabs_list"]),
    ])])
    #expect(actions.map(\.name) == ["click", "tabs_list"])
    #expect(actions[0].input == ["ref": .number(3)])
    #expect(actions[1].input == [:])

    for bad: [String: JSONValue] in [[:], ["actions": .array([])], ["actions": "click"], ["actions": .array([.object(["input": .object([:])])])], ["actions": .array([.object(["name": "click", "input": "ref 3"])])]] {
      #expect(throws: Failure.self, "\(bad)") { try Tools.batchActions(bad) }
    }

    #expect {
      try Tools.batchActions(["actions": .array([.object(["name": "browser_batch"])])])
    } throws: { error in
      (error as? Failure)?.description == "action 1: browser_batch cannot be nested"
    }
  }

  @Test func readConsoleMessagesMapsFiltersAndLimits() throws {
    #expect(try map("read_console_messages") == .consoleMessages(tabId: 20, onlyErrors: false, pattern: nil, limit: 50, clear: false))
    #expect(try map("read_console_messages", ["tabId": .number(7), "onlyErrors": .bool(true), "pattern": "MyApp", "limit": .number(200), "clear": .bool(true)]) == .consoleMessages(tabId: 7, onlyErrors: true, pattern: "MyApp", limit: 200, clear: true))
    #expect(try map("read_console_messages", ["pattern": ""]) == .consoleMessages(tabId: 20, onlyErrors: false, pattern: nil, limit: 50, clear: false))
    #expect(AppCommand.consoleMessages(tabId: 7, onlyErrors: false, pattern: nil, limit: 1, clear: false).targetTab == 7)
    #expect(throws: Failure.self) { try map("read_console_messages", ["limit": .number(201)]) }
    #expect(throws: Failure.self) { try map("read_console_messages", ["limit": .number(0)]) }
    #expect(throws: Failure.self) { try map("read_console_messages", ["onlyErrors": "yes"]) }
    #expect(try CommandLineParsing.parse(["--tab", "3", "console", "--errors", "--pattern", "boom|fail", "--limit", "5", "--clear"]).command == .consoleMessages(tabId: 3, onlyErrors: true, pattern: "boom|fail", limit: 5, clear: true))
    #expect(try CommandLineParsing.parse(["console"]).command == .consoleMessages(tabId: nil, onlyErrors: false, pattern: nil, limit: 50, clear: false))
    #expect(throws: Failure.self) { try CommandLineParsing.parse(["console", "--limit", "many"]) }
    #expect(throws: Failure.self) { try CommandLineParsing.parse(["console", "--verbose"]) }
  }

  @Test func javascriptMapsTextAndFrame() throws {
    #expect(try map("javascript", ["text": "document.title"]) == .javascript(tabId: 20, code: "document.title", frame: nil))
    #expect(try map("javascript", ["tabId": .number(7), "text": "1", "frame": "5:3"]) == .javascript(tabId: 7, code: "1", frame: PageRef(frames: [5], local: 3)))
    #expect(AppCommand.javascript(tabId: 7, code: "1", frame: nil).targetTab == 7)
    #expect(throws: Failure.self) { try map("javascript") }
    #expect(throws: Failure.self) { try map("javascript", ["text": " \n"]) }
    #expect(throws: Failure.self) { try map("javascript", ["text": .number(1)]) }
    #expect(try CommandLineParsing.parse(["--tab", "3", "javascript", "document.querySelectorAll('a').length", "--json-ish"]).command == .javascript(tabId: 3, code: "document.querySelectorAll('a').length --json-ish", frame: nil))
    #expect(try CommandLineParsing.parse(["javascript", "--frame", "5", "location.href"]).command == .javascript(tabId: nil, code: "location.href", frame: 5))
    #expect(throws: Failure.self) { try CommandLineParsing.parse(["javascript"]) }
    #expect(throws: Failure.self) { try CommandLineParsing.parse(["javascript", "--frame", "5.1", "1"]) }
  }

  @Test func removedToolsAreUnknown() {
    for name in ["hover", "drag", "right_click", "type"] {
      #expect("\(name)") { try map(name, ["ref": .number(1), "from": .number(1), "to": .number(2)]) } throws: { error in
        (error as? Failure)?.description == "unknown tool \(name)"
      }
    }
  }

  @Test func navigateSplitsHistoryFromUrls() throws {
    #expect(try map("navigate", ["url": "back"]) == .history(tabId: 20, direction: .back))
    #expect(try map("navigate", ["url": "forward", "tabId": .number(2)]) == .history(tabId: 2, direction: .forward))
    #expect(try map("navigate", ["url": "https://example.com"]) == .navigate(tabId: 20, url: "https://example.com"))
  }

  @Test func readPageDefaultsToAll() throws {
    #expect(try map("read_page") == .readPage(tabId: 20, filter: .all, maxChars: AppCommand.defaultMaxChars, ref: nil, depth: nil))
    #expect(try map("read_page", ["filter": "interactive", "max_chars": .number(900)]) == .readPage(tabId: 20, filter: .interactive, maxChars: 900, ref: nil, depth: nil))
  }

  @Test func scrollConvertsStepsToPixels() throws {
    #expect(try map("scroll", ["direction": "down"]) == .scroll(tabId: 20, ref: nil, left: 0, top: 300))
    #expect(try map("scroll", ["direction": "up", "amount": .number(2), "ref": .number(9)]) == .scroll(tabId: 20, ref: 9, left: 0, top: -200))
    #expect(try map("scroll", ["direction": "left", "amount": .number(1)]) == .scroll(tabId: 20, ref: nil, left: -100, top: 0))
    #expect(throws: Failure.self) { try map("scroll", ["direction": "sideways"]) }
  }

  @Test func keyMapsChordsRefAndRepeat() throws {
    let chords = try ["Backspace", "shift+Tab", "a"].map(KeyChord.parse)
    #expect(try map("key", ["keys": "Backspace  shift+Tab a"]) == .key(tabId: 20, chords: chords, ref: nil, times: 1))
    #expect(try map("key", ["keys": "Enter", "ref": .number(6), "repeat": "3", "tabId": .number(2)]) == .key(tabId: 2, chords: [KeyChord.parse("Enter")], ref: 6, times: 3))
    #expect(try map("key", ["keys": "Tab", "repeat": .number(100)]) == .key(tabId: 20, chords: [KeyChord.parse("Tab")], ref: nil, times: 100))
  }

  @Test func keyTypesText() throws {
    let chords = try ["H", "i", " ", "!", "Enter", "Tab"].map(KeyChord.parse)
    #expect(try map("key", ["text": "Hi !\n\t", "ref": .number(4)]) == .key(tabId: 20, chords: chords, ref: 4, times: 1))
    #expect(try map("key", ["text": .string(String(repeating: "a", count: 100))]) == .key(tabId: 20, chords: Array(repeating: KeyChord.parse("a"), count: 100), ref: nil, times: 1))

    for arguments: [String: JSONValue] in [["text": ""], ["text": "caf\u{E9}"], ["text": .string(String(repeating: "a", count: 101))], ["text": "a", "keys": "Enter"], [:]] {
      #expect(throws: Failure.self, "\(arguments)") { try map("key", arguments) }
    }
  }

  @Test func keyRejectsBadInput() {
    for keys: JSONValue in ["", "   ", "cmd+t", "Enter cmd+shift+w", "Bogus"] {
      #expect(throws: Failure.self, "\(keys)") { try map("key", ["keys": keys]) }
    }

    #expect(throws: Failure.self) { try map("key") }
    #expect(throws: Failure.self) { try map("key", ["keys": "Enter", "repeat": .number(0)]) }
    #expect(throws: Failure.self) { try map("key", ["keys": "Enter Tab", "repeat": .number(51)]) }
    #expect(throws: Failure.self) { try map("key", ["keys": "Enter Tab", "repeat": .number(4_611_686_018_427_387_904)]) }
    #expect(throws: Failure.self) { try map("key", ["keys": .number(5)]) }
  }

  @Test func logLabelsLeaveOutTypedText() throws {
    #expect(try map("key", ["text": "hunter2\n"]).logLabel == "key(tabId: Optional(20), keys: 7 characters Enter, ref: nil, times: 1)")
    #expect(try map("form_input", ["ref": .number(4), "value": "hunter2"]).logLabel == "formInput(tabId: Optional(20), ref: 4, value: text of 7 characters)")
    #expect(try map("handle_dialog", ["action": "accept", "prompt_text": "hunter2"]).logLabel == "dialog(tabId: Optional(20), accept: true, promptText: 7 characters)")
    #expect(try map("form_input", ["ref": .number(4), "value": .bool(true)]).logLabel.contains("checked(true)"))
    #expect(try map("navigate", ["url": "https://a.test/"]).logLabel.contains("https://a.test/"))
  }

  @Test func keyRefusalNamesSafariShortcuts() {
    #expect {
      try map("key", ["keys": "cmd+t"])
    } throws: { error in
      (error as? Failure)?.description.contains("cmd+t and cmd+w") == true
    }
  }

  @Test func tabToolsMap() throws {
    #expect(try map("tabs_list") == .tabs)
    #expect(try map("tab_create") == .tabCreate(url: nil, windowId: nil))
    #expect(try map("tab_create", ["url": "https://example.com"]) == .tabCreate(url: "https://example.com", windowId: nil))
    #expect(try map("tab_close", ["tabId": .number(3)]) == .tabClose(tabId: 3))
  }
}

struct CommandLineParsingTests {
  func parse(_ line: String) throws -> Invocation { try CommandLineParsing.parse(line.split(separator: " ").map(String.init)) }

  @Test func tabFlagWorksAnywhere() throws {
    #expect(try parse("--tab 4 click 12").command == .click(tabId: 4, ref: 12))
    #expect(try parse("click 12 --tab 4").command == .click(tabId: 4, ref: 12))
    #expect(try parse("ping").command == .ping(tabId: nil))
  }

  @Test func clickTakesActionAndModifiers() throws {
    #expect(try parse("click 5:12 --action double_click --modifiers shift+cmd").command == .click(tabId: nil, ref: PageRef(frames: [5], local: 12), action: .double, modifiers: [.cmd, .shift]))
    #expect(try parse("--tab 3 click 12 --modifiers ctrl").command == .click(tabId: 3, ref: 12, action: .left, modifiers: [.ctrl]))
    #expect(throws: Failure.self) { try parse("click 12 --action double") }
    #expect(throws: Failure.self) { try parse("click 12 --modifiers") }
  }

  @Test func freeTextIsJoined() throws {
    #expect(try parse("form-input 3 hello world").command == .formInput(tabId: nil, ref: 3, value: .text("hello world")))
    #expect(try parse("find Sign in").command == .find(tabId: nil, name: "Sign in", role: ""))
    #expect(try parse("find Sign in --role button").command == .find(tabId: nil, name: "Sign in", role: "button"))
    #expect(try parse("find --role searchbox").command == .find(tabId: nil, name: "", role: "searchbox"))
  }

  @Test func optionsAndDefaults() throws {
    #expect(try parse("read-page --all --max-chars 10").command == .readPage(tabId: nil, filter: .all, maxChars: 10, ref: nil, depth: nil))
    #expect(try parse("read-page --ref 4 --depth 2").command == .readPage(tabId: nil, filter: .interactive, maxChars: AppCommand.defaultMaxChars, ref: 4, depth: 2))
    #expect(try parse("scroll-to 6").command == .scrollTo(tabId: nil, ref: 6))
    #expect(try parse("resize 1000 700").command == .resizeWindow(tabId: nil, width: 1000, height: 700))
    #expect(try parse("screenshot a.png --region 0,0,50,40 --scale 0.5") == Invocation(command: .screenshot(tabId: nil, region: PixelRect(x0: 0, y0: 0, x1: 50, y1: 40), scale: 0.5), outputPath: "a.png"))
    #expect(try parse("read-page").command == .readPage(tabId: nil, filter: .interactive, maxChars: AppCommand.defaultMaxChars, ref: nil, depth: nil))
    #expect(try parse("scroll down 2 --ref 8").command == .scroll(tabId: nil, ref: 8, left: 0, top: 200))
    #expect(try parse("navigate back").command == .history(tabId: nil, direction: .back))
    #expect(try parse("screenshot shot.png") == Invocation(command: .screenshot(tabId: nil, region: nil, scale: 1), outputPath: "shot.png"))
  }

  @Test func debugCGParses() throws {
    #expect(try parse("debug-cg key cmd+a --ref 3").command == .debugCG(tabId: nil, probe: .key(KeyChord.parse("cmd+a"), ref: 3), windowFields: true))
    #expect(try parse("--tab 2 debug-cg click 5").command == .debugCG(tabId: 2, probe: .click(ref: 5), windowFields: true))
    #expect(try parse("debug-cg hover 6 --no-window-fields").command == .debugCG(tabId: nil, probe: .hover(ref: 6), windowFields: false))
    #expect(try parse("debug-cg drag 7 8").command == .debugCG(tabId: nil, probe: .drag(from: 7, to: 8), windowFields: true))
  }

  @Test func keyJoinsQuotedAndUnquotedWords() throws {
    let expected = try AppCommand.key(tabId: nil, chords: ["Backspace", "Backspace", "Enter"].map(KeyChord.parse), ref: nil, times: 1)
    #expect(try parse("key Backspace Backspace Enter").command == expected)
    #expect(try CommandLineParsing.parse(["key", "Backspace Backspace Enter"]).command == expected)
    #expect(try parse("--tab 4 key shift+Tab --ref 9 --repeat 2").command == .key(tabId: 4, chords: [KeyChord.parse("shift+Tab")], ref: 9, times: 2))
  }

  @Test func keyTextIsVerbatim() throws {
    let chords = try "a --ref b".map(KeyChord.typing)
    #expect(try parse("key --ref 9 --text a --ref b").command == .key(tabId: nil, chords: chords, ref: 9, times: 1))
    #expect(throws: Failure.self) { try parse("key Enter --text a") }
    #expect(throws: Failure.self) { try parse("key --text") }
  }

  @Test func keyRejectsBadInputButDebugCGTakesCmd() throws {
    for line in ["key", "key cmd+a", "key Enter --repeat 0", "key Enter --repeat 101", "key a b c d --repeat 26", "key Enter --repeat", "key Enter --ref x", "key Enter --bogus"] {
      #expect(throws: Failure.self, "\(line)") { try parse(line) }
    }

    #expect(try parse("key a b c d --repeat 25").command == .key(tabId: nil, chords: ["a", "b", "c", "d"].map(KeyChord.parse), ref: nil, times: 25))
    #expect(try parse("debug-cg key cmd+t").command == .debugCG(tabId: nil, probe: .key(KeyChord.parse("cmd+t"), ref: nil), windowFields: true))
  }

  @Test func debugCGRejectsBadInput() {
    for line in ["debug-cg", "debug-cg tap 3", "debug-cg click", "debug-cg drag 7", "debug-cg click 3 --ref 4", "debug-cg key Bogus", "debug-cg key Enter --no-window-fields", "debug-cg hover 3 --bogus"] {
      #expect(throws: Failure.self, "\(line)") { try parse(line) }
    }
  }

  @Test func removedCommandsAndFlagsAreUnknown() {
    let expected = ["hover 6": "unknown command hover", "drag 7 8": "unknown command drag", "debug-cg click 3 --global": "debug-cg click takes 1 argument, got 2", "debug-cg key Enter --global": "debug-cg key takes 1 argument, got 2"]

    for (line, message) in expected {
      #expect("\(line)") { try parse(line) } throws: { error in (error as? Failure)?.description == message }
    }
  }

  @Test func badInputFails() {
    #expect(throws: Failure.self) { try parse("click") }
    #expect(throws: Failure.self) { try parse("click abc") }
    #expect(throws: Failure.self) { try parse("tabs --bogus") }
    #expect(throws: Failure.self) { try parse("frobnicate") }
    #expect(throws: Failure.self) { try parse("--tab") }
  }
}
