import Foundation
import Testing

/// URL credentials are hidden in what a reply carries to the client, never in the TabInfo the app works from.
struct RedactionTests {
  struct Case: Decodable { let url: String; let shown: String }

  static let secretURL = "https://u:pw@site.test/cb?code=4/0Ab&state=s#access_token=ya29"
  static let shown = "https://[hidden]@site.test/cb?code=[hidden]&state=s#access_token=[hidden]"

  let tab = TabInfo(id: 4, windowId: 1, active: true, url: secretURL, title: "Back", windowFrame: CSSRect(left: 0, top: 0, width: 800, height: 600), openerId: nil, pilot: false)

  /// The same cases web/src/shared/redact.test.ts runs, so the two copies of the rule cannot drift.
  @Test func sharedCases() throws {
    let file = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "web/src/shared/redactUrl.cases.json")
    let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: file))
    #expect(cases.count > 10)

    for each in cases { #expect(Redaction.url(each.url) == each.shown, "\(each.url)") }
  }

  @Test func tabLinesHideCredentialsWhileTheTabKeepsItsURL() throws {
    #expect(tab.line == "* 4 w1 \(Self.shown) Back")
    let settled = SettleResult(tab: tab, navigation: .load, loading: false)
    #expect(settled.line == "landed on \(Self.shown) \"Back\"")
    #expect(tab.url == Self.secretURL)
    #expect(!settled.moved(from: Self.secretURL, replaced: false))
  }

  @Test func replyDataHidesEveryURLButLeavesOtherStrings() throws {
    let response: JSONValue = try .object([
      "ok": .bool(true),
      "tab": JSONValue(encoding: tab),
      "tabs": .array([JSONValue(encoding: tab)]),
      "json": .string("\"\(Self.secretURL)\""),
      "text": .string("page says \(Self.secretURL)"),
    ])
    let reply = CLIReply(ok: true, text: "opened tab 4 \(tab.shownURL) Back", data: response).forClient
    #expect(reply.data["tab"]?["url"]?.string == Self.shown)
    #expect(reply.data["tabs"]?.array.first?["url"]?.string == Self.shown)
    #expect(reply.data["json"]?.string == "\"\(Self.secretURL)\"")
    #expect(reply.data["text"]?.string == "page says \(Self.secretURL)")
    #expect(!reply.text.contains("pw@"))
    #expect(try response["tab"]?.decode(TabInfo.self).url == Self.secretURL)
  }

  @Test func windowMatchingFailuresHideURLs() throws {
    let other = WindowCandidate(title: "Mine", frame: CGRect(x: 0, y: 0, width: 10, height: 10), minimized: false, urls: ["https://bank.test/?session=abc"])
    #expect(throws: WindowMatchError.self) { try WindowMatching.match(tab: tab, candidates: [other]) }

    do {
      _ = try WindowMatching.match(tab: tab, candidates: [other])
    } catch {
      #expect(!error.description.contains("pw@") && !error.description.contains("abc"))
      #expect(error.description.contains(Self.shown) && error.description.contains("session=[hidden]"))
    }
  }

  @Test func logLabelsHideURLs() {
    #expect(AppCommand.navigate(tabId: 4, url: Self.secretURL).logLabel == "navigate(tabId: Optional(4), url: \(Self.shown))")
    #expect(AppCommand.tabCreate(url: Self.secretURL).logLabel == "tabCreate(url: \(Self.shown))")
  }
}
