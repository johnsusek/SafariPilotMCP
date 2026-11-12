import Foundation
import Testing

struct ToolMappingTests {
  func map(_ name: String, _ arguments: [String: JSONValue] = [:], session: Int? = 20) throws -> AppCommand { try Tools.command(name: name, arguments: arguments, sessionTab: session) }

  @Test func everyToolMapsWithItsRequiredArguments() throws {
    let samples: [String: JSONValue] = ["tabId": .number(7), "url": "https://example.com", "query": "Sign in", "ref": .number(3), "text": "hello", "direction": "down"]

    for tool in Tools.definitions {
      let arguments = samples.filter { tool.required.contains($0.key) }
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
    let tabless: Set = ["tabs_list", "tab_create"]

    for tool in Tools.definitions where !tabless.contains(tool.name) {
      #expect(tool.properties["tabId"] != nil, "\(tool.name)")
    }
  }

  @Test func schemaListsRequiredKeys() {
    let schema = Tools.definitions.first { $0.name == "type" }!.inputSchema
    #expect(schema["type"] == "object")
    #expect(schema["required"] == .array(["ref", "text"]))
  }

  @Test func omittedTabIdUsesTheSessionTab() throws {
    #expect(try map("click", ["ref": .number(4)]) == .click(tabId: 20, ref: 4))
    #expect(try map("get_page_text") == .pageText(tabId: 20, maxChars: AppCommand.defaultMaxChars))
    #expect(try map("screenshot", ["tabId": .null]) == .screenshot(tabId: 20))
  }

  @Test func explicitTabIdWins() throws {
    #expect(try map("click", ["ref": .number(4), "tabId": .number(3)]) == .click(tabId: 3, ref: 4))
    #expect(try map("click", ["ref": .number(4), "tabId": .number(3)], session: nil) == .click(tabId: 3, ref: 4))
  }

  @Test func pageToolsWithoutAnyTabFail() throws {
    for name in ["click", "type", "find", "read_page", "get_page_text", "scroll", "screenshot", "navigate"] {
      #expect("\(name)") {
        try map(name, ["ref": .number(1), "text": "x", "query": "q", "direction": "down", "url": "back"], session: nil)
      } throws: { error in
        (error as? Failure)?.description == Tools.noSessionTab
      }
    }

    #expect(try map("tabs_list", session: nil) == .tabs)
    #expect(try map("tab_create", session: nil) == .tabCreate(url: nil))
  }

  @Test func sessionFollowsTabCreateAndClose() {
    let created = CLIReply(ok: true, text: "", data: .object(["ok": .bool(true), "tab": .object(["id": .number(31)])]))
    let failed = CLIReply(ok: false, text: "", data: .object(["error": "no"]))
    let closed = CLIReply(ok: true, text: "", data: .object(["ok": .bool(true), "closed": .number(31)]))
    #expect(Tools.session(after: .tabCreate(url: nil), reply: created, current: nil) == 31)
    #expect(Tools.session(after: .tabCreate(url: nil), reply: created, current: 8) == 31)
    #expect(Tools.session(after: .tabCreate(url: nil), reply: failed, current: 8) == 8)
    #expect(Tools.session(after: .tabClose(tabId: 31), reply: closed, current: 31) == nil)
    #expect(Tools.session(after: .tabClose(tabId: 9), reply: closed, current: 31) == 31)
    #expect(Tools.session(after: .click(tabId: 9, ref: 1), reply: created, current: 31) == 31)
  }

  @Test func integersAcceptDigitStrings() throws {
    #expect(try map("type", ["tabId": "12", "ref": .number(5), "text": "abc"]) == .type(tabId: 12, ref: 5, text: "abc"))
  }

  @Test func wrongTypesFailLoudly() {
    #expect(throws: Failure.self) { try map("click", ["ref": .number(1.5)]) }
    #expect(throws: Failure.self) { try map("click", ["ref": .bool(true)]) }
    #expect(throws: Failure.self) { try map("click") }
    #expect(throws: Failure.self) { try map("tab_select") }
    #expect(throws: Failure.self) { try map("hover", ["ref": .number(1)]) }
    #expect(throws: Failure.self) { try map("read_page", ["filter": "visible"]) }
  }

  @Test func navigateSplitsHistoryFromUrls() throws {
    #expect(try map("navigate", ["url": "back"]) == .history(tabId: 20, direction: .back))
    #expect(try map("navigate", ["url": "forward", "tabId": .number(2)]) == .history(tabId: 2, direction: .forward))
    #expect(try map("navigate", ["url": "https://example.com"]) == .navigate(tabId: 20, url: "https://example.com"))
  }

  @Test func readPageDefaultsToAll() throws {
    #expect(try map("read_page") == .readPage(tabId: 20, filter: .all, maxChars: AppCommand.defaultMaxChars))
    #expect(try map("read_page", ["filter": "interactive", "max_chars": .number(900)]) == .readPage(tabId: 20, filter: .interactive, maxChars: 900))
  }

  @Test func scrollConvertsStepsToPixels() throws {
    #expect(try map("scroll", ["direction": "down"]) == .scroll(tabId: 20, ref: nil, left: 0, top: 300))
    #expect(try map("scroll", ["direction": "up", "amount": .number(2), "ref": .number(9)]) == .scroll(tabId: 20, ref: 9, left: 0, top: -200))
    #expect(try map("scroll", ["direction": "left", "amount": .number(1)]) == .scroll(tabId: 20, ref: nil, left: -100, top: 0))
    #expect(throws: Failure.self) { try map("scroll", ["direction": "sideways"]) }
  }

  @Test func tabToolsMap() throws {
    #expect(try map("tabs_list") == .tabs)
    #expect(try map("tab_create") == .tabCreate(url: nil))
    #expect(try map("tab_create", ["url": "https://example.com"]) == .tabCreate(url: "https://example.com"))
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

  @Test func freeTextIsJoined() throws {
    #expect(try parse("type 3 hello world").command == .type(tabId: nil, ref: 3, text: "hello world"))
    #expect(try parse("find Sign in").command == .find(tabId: nil, query: "Sign in"))
  }

  @Test func optionsAndDefaults() throws {
    #expect(try parse("read-page --all --max-chars 10").command == .readPage(tabId: nil, filter: .all, maxChars: 10))
    #expect(try parse("read-page").command == .readPage(tabId: nil, filter: .interactive, maxChars: AppCommand.defaultMaxChars))
    #expect(try parse("scroll down 2 --ref 8").command == .scroll(tabId: nil, ref: 8, left: 0, top: 200))
    #expect(try parse("navigate back").command == .history(tabId: nil, direction: .back))
    #expect(try parse("screenshot shot.png") == Invocation(command: .screenshot(tabId: nil), outputPath: "shot.png"))
  }

  @Test func badInputFails() {
    #expect(throws: Failure.self) { try parse("click") }
    #expect(throws: Failure.self) { try parse("click abc") }
    #expect(throws: Failure.self) { try parse("tabs --bogus") }
    #expect(throws: Failure.self) { try parse("frobnicate") }
    #expect(throws: Failure.self) { try parse("--tab") }
  }
}
