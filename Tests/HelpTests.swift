import Foundation
import Testing

/// The app's Help window shows README sections and the tools.
struct HelpTests {
  let readme = (try? String(contentsOf: URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "README.md"), encoding: .utf8)) ?? ""

  @Test func everyTopicIsAReadmeSection() {
    let topics = Help.topics(from: readme)
    #expect(topics.map(\.title) == Help.titles)

    for topic in topics {
      guard case .callout(_, let text) = topic.blocks.first, text.contains("is missing") else { continue }

      Issue.record("README has no section \"\(topic.title)\"")
    }
  }

  @Test func toolsListsEveryTool() {
    guard case .table(_, let rows) = Help.tools.blocks.last else {
      Issue.record("Tools has no table")
      return
    }

    #expect(rows.map(\.first) == Tools.definitions.map { "`\($0.name)`" })
  }

  @Test func blocksSplitCalloutsBulletsAndTables() {
    let blocks = Help.blocks(["> [!WARNING]", "> Careful", "> here.", "", "- one", "| Code | Fix |", "| --- | --- |", "| `a` | Do b. |", "Plain."])
    guard blocks.count == 4, case .callout("WARNING", "Careful here.") = blocks[0], case .bullet("one") = blocks[1], case .table(["Code", "Fix"], [["`a`", "Do b."]]) = blocks[2], case .text("Plain.") = blocks[3] else {
      Issue.record("\(blocks)")
      return
    }
  }
}
