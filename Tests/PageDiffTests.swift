import Foundation
import Testing

struct PageDiffTests {
  /// The background's JSON with fields replacing the defaults of an unchanged page.
  func diff(_ fields: String) throws -> PageDiffResult {
    let base = try JSONSerialization.jsonObject(with: Data(#"{"ok":true,"replaced":null,"tooLarge":false,"lines":[],"added":0,"changed":0,"removed":0,"omitted":0,"untracked":[],"pending":0,"settled":true}"#.utf8)) as! [String: Any]
    let changed = try JSONSerialization.jsonObject(with: Data("{\(fields)}".utf8)) as! [String: Any]
    let json = try JSONSerialization.data(withJSONObject: base.merging(changed) { $1 })
    return try JSONDecoder().decode(JSONValue.self, from: json).decode(PageDiffResult.self)
  }

  @Test func nothingDifferentIsPageUnchanged() throws {
    #expect(try diff("").text == "page unchanged")
  }

  @Test func changesFollowAHeaderCountingEachKind() throws {
    let lines = #"["in main [ref=40003]:","+ dialog \"Sign in\" [ref=41012]","+   button \"Continue\" [ref=41014]","~ button \"Menu\" [ref=40007] expanded (was collapsed)","- alert \"Saved\""]"#
    #expect(try diff(#""lines":\#(lines),"added":2,"changed":1,"removed":1"#).text == """
    page changed: 2 added, 1 changed, 1 removed
    in main [ref=40003]:
    + dialog "Sign in" [ref=41012]
    +   button "Continue" [ref=41014]
    ~ button "Menu" [ref=40007] expanded (was collapsed)
    - alert "Saved"
    """)
    #expect(try diff(#""lines":["- alert"],"removed":1"#).text == "page changed: 1 removed\n- alert")
  }

  @Test func aCutDiffCountsWhatWasLeftOutAndPointsAtReadPage() throws {
    #expect(try diff(#""lines":["+ a"],"added":4,"omitted":3"#).text == "page changed: 4 added\n+ a\n(3 more changed lines left out; read_page shows them)")
    #expect(try diff(#""lines":["+ a"],"added":2,"omitted":1"#).text.hasSuffix("(1 more changed line left out; read_page shows them)"))
  }

  @Test func aReplacedDocumentOrAPageTooLargeSaysSoInstead() throws {
    #expect(try diff(#""replaced":"","lines":["+ a"],"added":1"#).text == "the page was replaced, so read_page shows the new document")
    #expect(try diff(#""replaced":"5:3""#).text == "the frame of iframe 5:3 was replaced, so read_page shows the new document")
    #expect(try diff(#""tooLarge":true"#).text == "the page is too large to diff; read_page shows it")
  }

  @Test func anUnsettledOrUntrackedWaitIsNoted() throws {
    #expect(try diff(#""pending":1,"settled":false"#).text == "page unchanged\n(1 fetch or XHR request still loading 2 s after the action)")
    #expect(try diff(#""lines":["+ a"],"added":1,"pending":2,"settled":false"#).text.hasSuffix("\n+ a\n(2 fetch or XHR requests still loading 2 s after the action)"))
    #expect(try diff(#""settled":false"#).text == "page unchanged\n(the page was still changing 2 s after the action)")
    #expect(try diff(#""untracked":["","5"]"#).text == "page unchanged\n(fetch and XHR were not waited for in the page and the frame of iframe 5: no main-world capture answered)")
  }

  @Test func requestsCarryTheActedRefAndTheWait() {
    #expect(ContentRequest.diffStart(ref: PageRef(frames: [5], local: 12)).json == ["op": "diffStart", "ref": "5:12"])
    #expect(ContentRequest.diffStart(ref: nil).json == ["op": "diffStart", "ref": .null])
    #expect(ContentRequest.diff(ref: 7, waitMs: 1850, maxChars: PageDiffResult.maxChars).json == ["op": "diff", "ref": "7", "waitMs": .number(1850), "maxChars": .number(2000)])
  }
}
