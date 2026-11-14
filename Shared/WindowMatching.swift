import CoreGraphics
import Foundation

/// One Safari AX window as the matcher sees it: its frame, state, and the AXURL of each web area inside it.
struct WindowCandidate: Equatable, Sendable {
  let title: String
  let frame: CGRect?
  let minimized: Bool
  let urls: [String]

  var summary: String {
    let state = minimized ? " minimized" : ""
    let frameText = frame.map { String(format: "(%.0f, %.0f, %.0f x %.0f)", $0.minX, $0.minY, $0.width, $0.height) } ?? "no frame"
    return "\"\(title)\" \(frameText)\(state) urls [\(urls.map(Redaction.url).joined(separator: ", "))]"
  }
}

enum WindowMatchError: Error, CustomStringConvertible, Equatable {
  /// No window shows the URL yet; worth retrying while WebKit builds the AX tree.
  case noMatch(String)
  case ambiguous(String)
  case unreachable(String)

  var description: String {
    switch self {
    case let .noMatch(text), let .ambiguous(text), let .unreachable(text): text
    }
  }
}

enum WindowMatching {
  /// Ignores the fragment and a trailing slash, which AXURL and tabs.Tab.url can disagree on.
  static func normalize(_ url: String) -> String {
    guard var components = URLComponents(string: url) else { return url }

    components.fragment = nil
    let text = components.string ?? url
    return text.hasSuffix("/") ? String(text.dropLast()) : text
  }

  /// Index of the candidate showing the tab. windowFrame breaks ties between windows showing the same URL, and rules out a lone match
  /// in another window while the tab's own window, known by its frame, does not show the page in AX yet.
  static func match(tab: TabInfo, candidates: [WindowCandidate]) throws(WindowMatchError) -> Int {
    let wanted = normalize(tab.url)
    let matches = candidates.indices.filter { candidates[$0].urls.contains { normalize($0) == wanted } }
    let found = candidates.isEmpty ? "no Safari windows" : candidates.map(\.summary).joined(separator: "; ")

    guard !matches.isEmpty else { throw .noMatch("no Safari window shows tab \(tab.id) \(tab.shownURL); found: \(found)") }

    if matches.count == 1, let target = tab.windowFrame {
      let own = near(target, candidates)

      // The same page open in another window is the only match until WebKit builds the tab's page in AX; acting on it would press the wrong window.
      if !own.isEmpty, !own.contains(matches[0]) { throw .noMatch("the only Safari window showing \(tab.shownURL) is not at tab \(tab.id)'s windowFrame, and the window that is does not show it in Accessibility yet; found: \(found)") }
    }

    let index = try matches.count == 1 ? matches[0] : nearest(matches, tab: tab, candidates: candidates, found: found)
    let candidate = candidates[index]

    if candidate.minimized { throw .unreachable("the window showing tab \(tab.id) is minimized: \(candidate.summary)") }

    guard candidate.frame != nil else { throw .unreachable("the window showing tab \(tab.id) has no AX frame: \(candidate.summary)") }

    return index
  }

  /// Index of the window holding the tab by its windowFrame, the window title (the active tab's title) breaking ties; for when the tab's web area is gone from AX, as while a dialog replaces it.
  static func byFrame(tab: TabInfo, candidates: [WindowCandidate]) throws(WindowMatchError) -> Int {
    guard let target = tab.windowFrame else { throw .unreachable("tab \(tab.id) has no windowFrame to find its window by") }

    let close = near(target, candidates)
    let titled = close.count > 1 ? close.filter { candidates[$0].title == tab.title } : close
    let found = candidates.isEmpty ? "no Safari windows" : candidates.map(\.summary).joined(separator: "; ")
    let frameText = "(\(target.left), \(target.top), \(target.width) x \(target.height))"

    guard !titled.isEmpty else { throw .noMatch("no Safari window titled \"\(tab.title)\" is within \(Int(tolerance)) pt of tab \(tab.id)'s windowFrame \(frameText); found: \(found)") }
    guard titled.count == 1 else { throw .ambiguous("\(titled.count) Safari windows titled \"\(tab.title)\" are within \(Int(tolerance)) pt of tab \(tab.id)'s windowFrame \(frameText); found: \(found)") }

    return titled[0]
  }

  /// Summed edge offset under which a windows.Window frame counts as the same window as an AX frame.
  static let tolerance = 40.0

  private static func nearest(_ matches: [Int], tab: TabInfo, candidates: [WindowCandidate], found: String) throws(WindowMatchError) -> Int {
    guard let target = tab.windowFrame else { throw .ambiguous("\(matches.count) Safari windows show \(tab.shownURL) and the tab has no windowFrame; found: \(found)") }

    let close = near(target, candidates).filter(matches.contains)
    let frameText = "(\(target.left), \(target.top), \(target.width) x \(target.height))"

    guard close.count == 1 else { throw .ambiguous("\(matches.count) Safari windows show \(tab.shownURL) and \(close.count) are within \(Int(tolerance)) pt of windowFrame \(frameText); found: \(found)") }

    return close[0]
  }

  /// Indices of the candidates whose frame counts as the window with this windows.Window frame.
  private static func near(_ target: CSSRect, _ candidates: [WindowCandidate]) -> [Int] {
    candidates.indices.filter { candidates[$0].frame.map { distance($0, target) <= tolerance } ?? false }
  }

  /// Sum of edge offsets between an AX frame and a windows.Window frame, both top-left origin screen points.
  static func distance(_ frame: CGRect, _ target: CSSRect) -> Double {
    abs(frame.minX - target.left) + abs(frame.minY - target.top) + abs(frame.width - target.width) + abs(frame.height - target.height)
  }
}
