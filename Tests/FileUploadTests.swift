import Foundation
import Testing

struct FileUploadTests {
  let folder: URL

  init() throws {
    folder = FileManager.default.temporaryDirectory.appending(path: "upload-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  func write(_ name: String, _ bytes: Data, modified: Date? = nil) throws -> String {
    let url = folder.appending(path: name)
    try bytes.write(to: url)

    if let modified { try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: url.path) }

    return url.path
  }

  /// Sparse, so a file at the cap costs no disk or memory until it is read.
  func sparse(_ name: String, _ size: Int) throws -> String {
    let path = try write(name, Data())
    let handle = try FileHandle(forWritingTo: URL(filePath: path))
    try handle.truncate(atOffset: UInt64(size))
    try handle.close()
    return path
  }

  func map(_ arguments: [String: JSONValue]) throws -> AppCommand { try Tools.command(name: "file_upload", arguments: arguments, session: TabSession(owned: [20], current: 20)) }

  @Test func readsNameMimeTypeDateAndBytes() throws {
    let photo = try write("photo.png", Data([0x89, 0x50, 0x4E, 0x47]), modified: Date(timeIntervalSince1970: 1_700_000_000.5))
    let notes = try write("notes.unknownext", Data("hi".utf8))
    let files = try UploadFile.read([photo, notes])
    #expect(files.map(\.name) == ["photo.png", "notes.unknownext"])
    #expect(files.map(\.mimeType) == ["image/png", ""])
    #expect(files.map(\.size) == [4, 2])
    #expect(files[0].lastModified == 1_700_000_000_500)
    #expect(Data(base64Encoded: files[0].data) == Data([0x89, 0x50, 0x4E, 0x47]))
    #expect(Data(base64Encoded: files[1].data) == Data("hi".utf8))
  }

  @Test func symlinkUploadsItsTargetUnderItsOwnName() throws {
    let target = try write("target.txt", Data("target".utf8))
    let link = folder.appending(path: "link.txt")
    try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: target)
    let files = try UploadFile.read([link.path])
    #expect(files.map(\.name) == ["link.txt"])
    #expect(Data(base64Encoded: files[0].data) == Data("target".utf8))
  }

  @Test func refusesRelativeMissingAndDirectoryPaths() throws {
    for (paths, message) in [([String](), "at least one path"), (["notes.txt"], "not an absolute path"), ([folder.appending(path: "gone.txt").path], "cannot read"), ([folder.path], "not a regular file")] {
      do {
        _ = try UploadFile.read(paths)
        Issue.record("\(paths) was read")
      } catch {
        #expect("\(error)".contains(message), "\(error)")
      }
    }
  }

  @Test func capCoversAllFilesTogetherAndNamesTheFileOverIt() throws {
    let half = UploadFile.maxUploadBytes / 2 + 1
    let first = try sparse("first.bin", half)
    let second = try sparse("second.bin", half)
    let whole = try sparse("whole.bin", UploadFile.maxUploadBytes + 1)
    #expect(try UploadFile.read([first]).count == 1)

    do {
      _ = try UploadFile.read([first, second])
      Issue.record("two halves over the cap were read")
    } catch {
      #expect("\(error)".hasPrefix("second.bin brings the files to"), "\(error)")
    }

    do {
      _ = try UploadFile.read([whole])
      Issue.record("a file over the cap was read")
    } catch {
      #expect("\(error)".hasPrefix("whole.bin is"), "\(error)")
      #expect("\(error)".contains("nothing was uploaded"))
    }
  }

  @Test func toolMapsPathsAndRefAndKeepsBytesOutOfTheLog() throws {
    let path = try write("a.txt", Data("secret bytes".utf8))
    let command = try map(["ref": "5:12", "paths": .array([.string(path)])])
    guard case let .fileUpload(tabId, ref, files) = command else { throw Failure(description: "mapped to \(command)") }

    #expect(tabId == 20)
    #expect(ref == PageRef(frames: [5], local: 12))
    #expect(files.map(\.name) == ["a.txt"])
    #expect(command.targetTab == 20)
    #expect(!String(describing: command).contains(files[0].data))
    #expect(String(describing: command).contains("a.txt (12 bytes)"))
    #expect(try JSONDecoder().decode(AppCommand.self, from: JSONEncoder().encode(command)) == command)
  }

  @Test func browserBatchCarriesAnUpload() throws {
    let path = try write("c.txt", Data("c".utf8))
    let actions = try Tools.batchActions(["actions": .array([.object(["name": "file_upload", "input": .object(["ref": "5:12", "paths": .array([.string(path)])])])])])
    #expect(actions.map(\.name) == ["file_upload"])
    #expect(try map(actions[0].input) == .fileUpload(tabId: 20, ref: PageRef(frames: [5], local: 12), files: UploadFile.read([path])))
  }

  @Test func toolRefusesBadArguments() throws {
    let path = try write("a.txt", Data("a".utf8))

    for arguments: [String: JSONValue] in [["ref": .number(3)], ["paths": .array([.string(path)])], ["ref": .number(3), "paths": .string(path)], ["ref": .number(3), "paths": .array([.number(1)])], ["ref": .number(3), "paths": .array([])]] {
      #expect(throws: Failure.self, "\(arguments)") { try map(arguments) }
    }

    let tool = Tools.definitions.first { $0.name == "file_upload" }!
    #expect(tool.required == ["ref", "paths"])
    #expect(tool.properties["paths"]?["type"] == "array")
  }

  @Test func contentRequestCarriesTheFiles() throws {
    let file = UploadFile(name: "a.txt", mimeType: "text/plain", lastModified: 5, size: 1, data: "YQ==")
    #expect(ContentRequest.upload(ref: PageRef(frames: [5], local: 12), files: [file]).json == ["op": "upload", "ref": "5:12", "files": .array([.object(["name": "a.txt", "mimeType": "text/plain", "lastModified": .number(5), "data": "YQ=="])])])
    let result = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"ok":true,"ref":"5:12","target":"input#file","via":"drop","files":[{"name":"a.txt","size":1,"type":""}],"dispatched":[{"type":"drop","canceled":true}]}"#.utf8)).decode(UploadResult.self)
    #expect(result.via == .drop)
    #expect(result.files == [UploadResult.Sent(name: "a.txt", size: 1, type: "")])
  }

  @Test func cliTakesRefAndPathsResolvingRelativeOnes() throws {
    let path = try write("b.txt", Data("b".utf8))
    let invocation = try CommandLineParsing.parse(["--tab", "3", "file-upload", "5:2", path])
    guard case let .fileUpload(tabId, ref, files) = invocation.command else { throw Failure(description: "parsed to \(invocation.command)") }

    #expect(tabId == 3)
    #expect(ref == PageRef(frames: [5], local: 2))
    #expect(files.map(\.name) == ["b.txt"])
    #expect(throws: Failure.self) { try CommandLineParsing.parse(["file-upload", "5"]) }

    do {
      _ = try CommandLineParsing.parse(["file-upload", "4", "missing-\(UUID().uuidString).txt"])
      Issue.record("a missing relative path was read")
    } catch {
      #expect("\(error)".hasPrefix("cannot read \(FileManager.default.currentDirectoryPath)/missing-"), "\(error)")
    }
  }
}
