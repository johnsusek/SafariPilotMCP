import Foundation
import Testing

struct ContractTests {
  func decode<Result: Decodable>(_ type: Result.Type, _ json: String) throws -> Result {
    try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)).decode(type)
  }

  let viewport = #"{"innerWidth":1200,"innerHeight":800,"scrollX":0,"scrollY":40,"devicePixelRatio":2,"visualScale":1,"visualOffsetLeft":0,"visualOffsetTop":0}"#
  let tab = #"{"id":12,"windowId":3,"active":false,"url":"https://a.test/","title":"A","windowFrame":{"left":0,"top":25,"width":1200,"height":900}}"#

  @Test func tabInfoDecodesWithAndWithoutWindowFrame() throws {
    let decoded = try decode(TabsResult.self, #"{"ok":true,"tabs":[\#(tab),{"id":13,"windowId":3,"active":true,"url":"","title":"","windowFrame":null,"openerId":12}]}"#)
    #expect(decoded.tabs[0] == TabInfo(id: 12, windowId: 3, active: false, url: "https://a.test/", title: "A", windowFrame: CSSRect(left: 0, top: 25, width: 1200, height: 900), openerId: nil))
    #expect(decoded.tabs[1].windowFrame == nil)
    #expect(decoded.tabs[1].openerId == 12)
  }

  @Test func tabClosedAndScreenshotResultsDecode() throws {
    #expect(try decode(TabResult.self, #"{"ok":true,"tab":\#(tab)}"#).tab.id == 12)
    #expect(try decode(ClosedResult.self, #"{"ok":true,"closed":12}"#).closed == 12)
    #expect(try decode(ScreenshotResult.self, #"{"ok":true,"dataUrl":"data:image/png;base64,AAAA","tab":\#(tab)}"#).tab.windowId == 3)
  }

  @Test func contentResultsDecode() throws {
    let element = #"{"ref":4,"tag":"button","role":"button","name":"Go","rect":{"left":1,"top":2,"width":3,"height":4},"inViewport":true}"#
    #expect(try decode(ReadPageResult.self, #"{"ok":true,"url":"u","title":"t","viewport":\#(viewport),"text":"[4] button Go","truncated":true}"#).truncated)
    #expect(try decode(FindResult.self, #"{"ok":true,"matches":[\#(element)]}"#).matches[0].disabled == nil)
    #expect(try decode(PageTextResult.self, #"{"ok":true,"url":"u","title":"t","text":"hello","truncated":false}"#).text == "hello")
    #expect(try decode(ScrollResult.self, #"{"ok":true,"moved":false,"viewport":\#(viewport)}"#).viewport.scrollY == 40)
    #expect(try decode(LocateResult.self, #"{"ok":true,"ref":4,"rect":{"left":1,"top":2,"width":3,"height":4},"point":{"left":2,"top":4},"hitsTarget":true,"hitDescription":"button","viewport":\#(viewport)}"#).point == CSSPoint(left: 2, top: 4))
    let events = try decode(EventsResult.self, #"{"ok":true,"events":[{"type":"click","isTrusted":true,"ref":null,"target":"button","time":1.5,"detail":"","count":3}],"origin":1762900000123.4}"#)
    #expect(events.events[0].count == 3)
    #expect(events.origin == 1762900000123.4)
    #expect(throws: (any Error).self) { try decode(EventsResult.self, #"{"ok":true,"events":[]}"#) }
    #expect(try decode(InspectResult.self, #"{"ok":true,"ref":4,"hover":true,"value":null,"kind":"other","checked":null,"selectedIndex":null,"options":null}"#).hover)
    let select = try decode(InspectResult.self, #"{"ok":true,"ref":4,"hover":false,"value":"1","kind":"select","checked":null,"selectedIndex":0,"options":[{"value":"1","label":"One","disabled":false}]}"#)
    #expect(select.kind == .select)
    #expect(select.options == [SelectOption(value: "1", label: "One", disabled: false)])
  }

  @Test func commandsEncodeTheContractShapes() {
    #expect(BackgroundCommand.tab(tabId: nil).json == ["type": "tab", "tabId": .null])
    #expect(BackgroundCommand.tabCreate(url: nil).json == ["type": "tabCreate", "url": .null])
    #expect(BackgroundCommand.history(tabId: 4, direction: .back).json == ["type": "history", "tabId": .number(4), "direction": "back"])
    #expect(BackgroundCommand.screenshot(tabId: 9).json == ["type": "screenshot", "tabId": .number(9)])
    #expect(BackgroundCommand.content(tabId: 2, request: .scroll(ref: nil, left: 0, top: 300)).json == [
      "type": "content", "tabId": .number(2), "request": .object(["op": "scroll", "ref": .null, "left": .number(0), "top": .number(300)]),
    ])
    #expect(ContentRequest.events(clear: true, arm: true).json == ["op": "events", "clear": .bool(true), "arm": .bool(true)])
    #expect(ContentRequest.inspect(ref: 5).json == ["op": "inspect", "ref": .number(5)])
    #expect(ContentRequest.readPage(filter: .interactive, maxChars: 100, ref: nil, depth: 3).json == ["op": "readPage", "filter": "interactive", "maxChars": .number(100), "ref": .null, "depth": .number(3)])
    #expect(ContentRequest.scrollIntoView(ref: 7).json == ["op": "scrollIntoView", "ref": .number(7)])
    #expect(BackgroundCommand.resize(tabId: 4, width: 1200, height: 800).json == ["type": "resize", "tabId": .number(4), "width": .number(1200), "height": .number(800)])
  }

  @Test func appCommandRoundTripsThroughCLIRequest() throws {
    let request = CLIRequest(command: .scroll(tabId: nil, ref: 3, left: 0, top: -200), timeoutSeconds: 45)
    let decoded = try JSONDecoder().decode(CLIRequest.self, from: JSONEncoder().encode(request))
    #expect(decoded.command == request.command)
    #expect(decoded.kind == "cli")
    let probe = AppCommand.debugCG(tabId: 2, probe: .key(try KeyChord.parse("cmd+a"), ref: 4), windowFields: true)
    #expect(try JSONDecoder().decode(AppCommand.self, from: JSONEncoder().encode(probe)) == probe)
    let key = try AppCommand.key(tabId: 5, keys: "Backspace shift+Tab A", text: nil, ref: 7, times: 3)
    #expect(try JSONDecoder().decode(AppCommand.self, from: JSONEncoder().encode(key)) == key)
    let form = AppCommand.formInput(tabId: nil, ref: 2, value: .checked(false))
    #expect(try JSONDecoder().decode(AppCommand.self, from: JSONEncoder().encode(form)) == form)
    #expect(try JSONDecoder().decode(AppCommand.self, from: JSONEncoder().encode(key)) == key)
  }
}
