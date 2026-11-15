/// What an action changed on the page, as the extension's diff answers it (PageDiffResult in web/src/shared/commands.ts): lines are context lines ("in main [ref=4]:")
/// and change lines starting "+ ", "~ " or "- ". replaced is the path of a frame whose document was replaced ("" for the page), omitted the change lines cut at maxChars,
/// untracked the frames whose fetch and XHR were not waited for, pending those still loading, and settled whether every frame was still when its wait ended.
struct PageDiffResult: Codable, Sendable, Equatable {
  static let maxChars = 2000
  /// The wait for the page to settle ends this long after the input.
  static let wait = Duration.seconds(2)

  let replaced: String?
  let tooLarge: Bool
  let lines: [String]
  let added: Int
  let changed: Int
  let removed: Int
  let omitted: Int
  let untracked: [String]
  let pending: Int
  let settled: Bool

  var text: String {
    let frame = { (path: String) in path.isEmpty ? "the page" : "the frame of iframe \(path)" }

    if let replaced { return "\(frame(replaced)) was replaced, so read_page shows the new document" }

    if tooLarge { return "the page is too large to diff; read_page shows it" }

    let counts = [(added, "added"), (changed, "changed"), (removed, "removed")].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
    var text = counts.isEmpty ? ["page unchanged"] : ["page changed: \(counts.joined(separator: ", "))"] + lines

    if omitted > 0 { text.append("(\(omitted) more changed \(omitted == 1 ? "line" : "lines") left out; read_page shows them)") }

    if pending > 0 {
      text.append("(\(pending) fetch or XHR \(pending == 1 ? "request" : "requests") still loading 2 s after the action)")
    } else if !settled {
      text.append("(the page was still changing 2 s after the action)")
    }

    if !untracked.isEmpty { text.append("(fetch and XHR were not waited for in \(untracked.map(frame).joined(separator: " and ")): no main-world capture answered)") }

    return text.joined(separator: "\n")
  }
}
