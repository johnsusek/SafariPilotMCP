import Foundation
import Testing

/// Every failure carries a code, and the MCP result ends with its error line and repeats it in structuredContent.
struct ErrorCodeTests {
  struct Entry: Decodable, Equatable { let retryable: Bool; let next: String }
  struct Table: Decodable { let next: [String]; let codes: [String: Entry] }

  /// The table web/src/shared/errorCodes.json holds, which the web Failure type takes its codes from.
  @Test func theEnumMatchesTheSharedTable() throws {
    let file = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "web/src/shared/errorCodes.json")
    let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: file))
    #expect(ErrorCode.Next.allCases.map(\.rawValue) == table.next)
    #expect(Set(ErrorCode.allCases.map(\.rawValue)) == Set(table.codes.keys))

    for code in ErrorCode.allCases { #expect(table.codes[code.rawValue] == Entry(retryable: code.retryable, next: code.next.rawValue), "\(code)") }
  }

  @Test func anActionThatMayHaveRunIsNeverRetryable() {
    #expect(!ErrorCode.timedOut.retryable && ErrorCode.timedOut.next == .readPage)
    #expect(!ErrorCode.inputUnconfirmed.retryable && ErrorCode.inputUnconfirmed.next == .readPage)
    #expect(ErrorCode.allCases.filter(\.retryable) == [.pageBusy, .waitTimeout])
    #expect(ToolResult.failed(Failure(.timedOut, "SafariPilot.app sent no reply within 65 s")).errorLine == "error code=timed_out retryable=false next=read_page")
  }

  @Test func aFailedReplyEndsWithTheErrorLineAndRepeatsItAsStructuredContent() {
    let text = "ref 12 is not hittable: covered by div#overlay"
    let result = ToolResult.reply(CLIReply(failing: .notActionable, text: text, data: .null))
    #expect(!result.ok)
    #expect(result.shown == [.text("\(text)\nerror code=not_actionable retryable=false next=read_page")])
    #expect(result.structured == .object(["code": "not_actionable", "retryable": .bool(false), "next": "read_page", "message": .string(text)]))
  }

  @Test func successesCarryNoErrorLineAndAReplyWithoutACodeIsFailed() {
    let ok = ToolResult.reply(CLIReply(ok: true, text: "clicked", data: .null))
    #expect(ok.ok && ok.errorLine == nil && ok.structured == nil && ok.shown == [.text("clicked")])
    #expect(ToolResult.reply(CLIReply(ok: false, text: "old app", data: .null)).code == .failed)
    #expect(ToolResult.failed(CancellationError()).code == .failed)
  }

  @Test func browserBatchStopsAtTheFailingStepAndCarriesItsCode() async {
    var ran: [String] = []
    let actions: [(name: String, input: [String: JSONValue])] = [("find", [:]), ("screenshot", [:]), ("click", [:]), ("key", [:])]
    let result = await ToolResult.batch(actions) { name, _ in
      ran.append(name)

      switch name {
      case "screenshot": return ToolResult(items: [.png("AAAA"), .text("screenshot of tab 4")])
      case "click": return .reply(CLIReply(failing: .inputUnconfirmed, text: "pressed button \"Save\", but no click reached the page", data: .null))
      default: return .text("[12] button \"Save\"")
      }
    }

    #expect(ran == ["find", "screenshot", "click"])
    #expect(result.code == .inputUnconfirmed && result.step == 3)
    #expect(result.shown == [
      .text("1/4 find:\n[12] button \"Save\"\n2/4 screenshot:"),
      .png("AAAA"),
      .text("screenshot of tab 4\n3/4 click failed:\npressed button \"Save\", but no click reached the page\nstopped after 3 of 4 actions\nerror code=input_unconfirmed retryable=false next=read_page step=3"),
    ])
    #expect(result.structured?["step"] == .number(3))
    #expect(result.structured?["code"] == "input_unconfirmed")
  }

  @Test func aBatchThatFinishesHasNoCode() async {
    let result = await ToolResult.batch([("find", [:])]) { _, _ in .text("no matches") }
    #expect(result == ToolResult(items: [.text("1/1 find:\nno matches")]))
  }

  @Test func badArgumentsAndBadBatchesAreInvalidArguments() throws {
    for arguments: [String: JSONValue] in [[:], ["ref": "x:y"], ["ref": .number(1), "action": "hover"]] {
      #expect(throws: Failure.self) { try Tools.command(name: "click", arguments: arguments, session: TabSession(owned: [4], current: 4)) }

      do { _ = try Tools.command(name: "click", arguments: arguments, session: TabSession(owned: [4], current: 4)) } catch { #expect(ErrorCode(of: error) == .invalidArgument, "\(arguments)") }
    }

    #expect(throws: Failure.self) { try Tools.batchActions(["actions": .array([])]) }
    do { _ = try Tools.batchActions(["actions": .array([])]) } catch { #expect(ErrorCode(of: error) == .invalidArgument) }
  }

  @Test func aFrameTheActionNeedsIsBusyOrGone() throws {
    let read = EventsResult(events: [], origin: 1, origins: ["": 1], busy: ["5"])
    try read.requireAnswered("", so: "x")

    #expect { try read.requireAnswered("5", so: "nothing was clicked") } throws: { error in
      (error as? Failure)?.code == .pageBusy && "\(error)" == "the frame of iframe 5 did not answer within 2 s, so nothing was clicked"
    }
    #expect { try read.requireAnswered("7", so: "nothing was pressed") } throws: { error in
      (error as? Failure)?.code == .staleRef && "\(error)" == "the frame of iframe 7 could not be read, so nothing was pressed"
    }
  }

  @Test func aRefusedHelloAndABadTokenSayWhoMustAct() throws {
    #expect(try HelloReply(session: "key", text: "approved").approvedSession == "key")
    #expect { try HelloReply(session: nil, text: "The user did not allow Claude to use Safari through SafariPilot.").approvedSession } throws: { error in
      (error as? Failure)?.code == .approvalRequired
    }

    guard case let .failure(failure)? = Wire.authenticate(Data("wrong\n{}".utf8), token: Data("right".utf8)) else { throw Failure(.failed, "the wrong token was accepted") }

    #expect(failure.code == .appUnavailable)
  }

  @Test func theBuildMismatchKeepsTheStaleCopysPathBesideItsCode() {
    let reply = CLIReply(failed: BuildMismatch(app: "new", background: "old", appex: "old", appexPath: "/tmp/Old.app"))
    #expect(reply.code == .buildMismatch)
    #expect(reply.data["buildMismatch"]?["appexPath"] == "/tmp/Old.app")
    #expect(ToolResult.reply(reply).errorLine == "error code=build_mismatch retryable=false next=ask_user")
  }
}
