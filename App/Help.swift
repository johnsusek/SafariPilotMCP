import Foundation

/// Help topics are README sections bundled with the app, so the two never drift apart.
enum Help {
  enum Block: Sendable {
    case text(String), bullet(String), callout(kind: String, text: String), table(header: [String], rows: [[String]])
  }

  struct Topic: Identifiable, Sendable {
    let title: String
    let blocks: [Block]
    var id: String { title }
  }

  static let titles = ["Security and Trust", "Troubleshooting"]

  static let readme: String = {
    guard let url = Bundle.main.url(forResource: "README", withExtension: "md"), let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
    return text
  }()

  /// The README sections, then the MCP tools with the descriptions agents get.
  static let topics = topics(from: readme) + [tools]

  static let tools = Topic(title: "Tools", blocks: [.text("This is the list of tools and their descriptions this MCP server advertises to clients."), .table(header: ["Tool", "Description"], rows: Tools.definitions.map { ["`\($0.name)`", $0.description] })])

  static func topics(from readme: String) -> [Topic] {
    var sections: [String: [String]] = [:]
    var current: String?

    for line in readme.components(separatedBy: "\n") {
      if line.hasPrefix("## ") {
        current = String(line.dropFirst(3))
        continue
      }

      if line.hasPrefix("# ") {
        current = nil
        continue
      }

      if let current { sections[current, default: []].append(line) }
    }

    return titles.map { title in Topic(title: title, blocks: sections[title].map(blocks) ?? [.callout(kind: "CAUTION", text: "README section \"\(title)\" is missing from this build.")]) }
  }

  static func blocks(_ lines: [String]) -> [Block] {
    var blocks: [Block] = []
    var index = 0

    while index < lines.count {
      let line = lines[index]
      index += 1

      if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }

      if line.hasPrefix("> [!") {
        let kind = String(line.dropFirst(4).prefix { $0 != "]" })
        var text: [String] = []

        while index < lines.count, lines[index].hasPrefix(">") {
          text.append(lines[index].dropFirst().trimmingCharacters(in: .whitespaces))
          index += 1
        }

        blocks.append(.callout(kind: kind, text: text.joined(separator: " ")))
        continue
      }

      if line.hasPrefix("|") {
        var rows = [cells(line)]

        while index < lines.count, lines[index].hasPrefix("|") {
          rows.append(cells(lines[index]))
          index += 1
        }

        // The second row is the |---| separator.
        blocks.append(.table(header: rows[0], rows: Array(rows.dropFirst(2))))
        continue
      }

      if line.hasPrefix("- ") {
        blocks.append(.bullet(String(line.dropFirst(2))))
        continue
      }

      blocks.append(.text(line))
    }

    return blocks
  }

  static func cells(_ line: String) -> [String] {
    line.trimmingCharacters(in: CharacterSet(charactersIn: "| ")).components(separatedBy: " | ").map { $0.trimmingCharacters(in: .whitespaces) }
  }

  static func inline(_ markdown: String) -> AttributedString {
    (try? AttributedString(markdown: markdown, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(markdown)
  }
}
