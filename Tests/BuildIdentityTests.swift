import Foundation
import Testing

struct BuildIdentityTests {
  let path = "/Users/me/Code/SafariPilot/build/TestData/Build/Products/Debug/SafariPilot.app/Contents/PlugIns/SafariPilotExtension.appex"

  func message(background: String?, appex: String?) throws -> JSONValue {
    let instance = background.map { #","build":"\#($0)""# } ?? ""
    let relayed = appex.map { #""\#($0)""# } ?? "null"
    let line = #"{"kind":"poll","instance":{"id":"i1","startedAt":1\#(instance)},"appex":{"build":\#(relayed),"path":"\#(path)"}}"#
    return try JSONDecoder().decode(JSONValue.self, from: Data(line.utf8))
  }

  @Test func aPollNamesBothBuildsAndTheAppExtensionPath() throws {
    let seen = try ExtensionBuild(message: message(background: "b1", appex: "a1"))
    #expect(seen == ExtensionBuild(background: "b1", appex: "a1", appexPath: path))
  }

  @Test func matchingBuildsPass() throws {
    #expect(try ExtensionBuild(message: message(background: "x", appex: "x")).mismatch(app: "x") == nil)
  }

  @Test func aDifferentBackgroundIsAMismatch() throws {
    let mismatch = try #require(ExtensionBuild(message: message(background: "old", appex: "x")).mismatch(app: "x"))
    #expect(mismatch == BuildMismatch(app: "x", background: "old", appex: "x", appexPath: path))
  }

  @Test func aDifferentAppExtensionIsAMismatch() throws {
    #expect(try ExtensionBuild(message: message(background: "x", appex: "old")).mismatch(app: "x") != nil)
  }

  @Test func aMissingIdentityIsAMismatchNeverAPass() throws {
    #expect(try ExtensionBuild(message: message(background: nil, appex: "x")).mismatch(app: "x") != nil)
    #expect(try ExtensionBuild(message: message(background: "x", appex: nil)).mismatch(app: "x") != nil)
    #expect(try ExtensionBuild(message: message(background: nil, appex: nil)).mismatch(app: nil) != nil)
    #expect(ExtensionBuild(message: .object(["kind": "poll"])).mismatch(app: "x") != nil)
  }

  @Test func theMismatchNamesBothSidesTheCopyAndTheFix() {
    let text = BuildMismatch(app: "new", background: "old", appex: nil, appexPath: path).description
    #expect(text.contains("this app: new"))
    #expect(text.contains("extension old, app extension none at \(path)"))
    #expect(text.contains("scripts/install.sh"))
  }

  @Test func aFailedReplyMarksTheMismatchOnTheWire() throws {
    let mismatch = BuildMismatch(app: "new", background: "old", appex: "old", appexPath: path)
    let reply = CLIReply(failed: mismatch)
    #expect(!reply.ok && reply.code == .buildMismatch)
    #expect(reply.data["buildMismatch"] == .object(["app": "new", "background": "old", "appex": "old", "appexPath": .string(path)]))
    #expect(reply.data["error"]?.string == mismatch.description)
    #expect(try JSONDecoder().decode(CLIReply.self, from: JSONEncoder().encode(reply)).data["buildMismatch"]?.decode(BuildMismatch.self) == mismatch)
    #expect(CLIReply(failed: Failure(.failed, "other")).data["buildMismatch"] == nil)
  }

  @Test func theIdentityIsReadFromTheAppExtensionsResources() throws {
    let stamped = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).appex")
    let bare = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).appex")
    defer { for appex in [stamped, bare] { try? FileManager.default.removeItem(at: appex) } }

    for appex in [stamped, bare] {
      try FileManager.default.createDirectory(at: appex.appending(path: "Contents/Resources"), withIntermediateDirectories: true)
    }

    try Data(#"{"build":"20261113T120000-abc123"}"#.utf8).write(to: stamped.appending(path: "Contents/Resources/build.json"))
    #expect(BuildIdentity.read(appex: stamped) == "20261113T120000-abc123")
    #expect(BuildIdentity.read(appex: bare) == nil)
  }
}
