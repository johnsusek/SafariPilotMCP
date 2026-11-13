/// Mirrors of web/src/shared/commands.ts and protocol.ts. Result structs omit `ok`; Commands checks it before decoding.
struct CSSRect: Codable, Sendable, Equatable {
  let left: Double
  let top: Double
  let width: Double
  let height: Double
}

struct CSSPoint: Codable, Sendable, Equatable {
  let left: Double
  let top: Double
}

struct TabInfo: Codable, Sendable, Equatable {
  let id: Int
  let windowId: Int
  let active: Bool
  let url: String
  let title: String
  let windowFrame: CSSRect?
  let openerId: Int?

  var line: String { "\(active ? "*" : " ") \(id) w\(windowId) \(url) \(title)\(openerId.map { " (opened by \($0))" } ?? "")" }
}

struct ElementInfo: Codable, Sendable, Equatable {
  let ref: PageRef
  let tag: String
  let role: String
  let name: String
  let rect: CSSRect
  let inViewport: Bool
  let disabled: Bool?
}

struct LoggedEvent: Codable, Sendable, Equatable {
  let type: String
  let isTrusted: Bool
  let ref: PageRef?
  let target: String
  let time: Double
  let detail: String
  let count: Int
  /// Path of the frame that logged it, "" for the top frame.
  let frame: String
  /// Set when events were read with a watch on this frame: whether the event hit the watched element, one of its labels or an ancestor of it.
  let onTarget: Bool?
}

struct PingResult: Codable, Sendable { let url: String; let title: String }
struct SnapshotResult: Codable, Sendable { let url: String; let title: String; let viewport: Viewport; let elements: [ElementInfo] }
/// Rects are in top-frame CSS px; sandboxed means the element's frame is sandboxed without allow-scripts, so no page listener can confirm a click or key there.
struct LocateResult: Codable, Sendable { let ref: PageRef; let rect: CSSRect; let point: CSSPoint; let hitsTarget: Bool; let covered: Bool; let hitDescription: String; let viewport: Viewport; let sandboxed: Bool }
/// target is what the events went to; dispatched lists their types in order, canceled when a page listener called preventDefault; focused is the active element afterwards.
struct SyntheticClickResult: Codable, Sendable {
  struct Dispatched: Codable, Sendable { let type: String; let canceled: Bool }

  let ref: PageRef
  let target: String
  let dispatched: [Dispatched]
  let focused: String
}
/// via says whether a file input took the files or they were dropped on target; files are read back from the page; dispatched lists the events in order, canceled when a listener called preventDefault.
struct UploadResult: Codable, Sendable {
  enum Via: String, Codable, Sendable { case input, drop }
  struct Sent: Codable, Sendable, Equatable { let name: String; let size: Int; let type: String }

  let ref: PageRef
  let target: String
  let via: Via
  let files: [Sent]
  let dispatched: [SyntheticClickResult.Dispatched]
}
/// Events from every frame. origin is the top frame's performance.timeOrigin and origins each answering frame's, keyed by frame path; a different origin between two reads means that frame navigated or reloaded. busy lists frames that did not answer in time, which are not gone.
struct EventsResult: Codable, Sendable {
  let events: [LoggedEvent]
  let origin: Double
  let origins: [String: Double]
  let busy: [String]

  /// Whether a frame answered with another document than in before, or is gone; a busy frame is neither.
  func replaced(_ frame: String, since before: EventsResult) -> Bool { !busy.contains(frame) && origins[frame] != before.origins[frame] }
}
/// listbox is a select shown as a list (multiple or size over 1); date, time and datetime-local are inputs WebKit draws as separate typed fields; checked is set for checkbox and radio, selectedIndex and options for both select kinds.
enum ControlKind: String, Codable, Sendable { case text, checkbox, radio, select, listbox, date, time, dateTimeLocal = "datetime-local", color, other }
struct SelectOption: Codable, Sendable, Equatable { let value: String; let label: String; let disabled: Bool }
struct InspectResult: Codable, Sendable {
  let ref: PageRef
  let hover: Bool
  let value: String?
  let secure: Bool
  let kind: ControlKind
  let checked: Bool?
  let selectedIndex: Int?
  let options: [SelectOption]?
}
struct ReadPageResult: Codable, Sendable { let url: String; let title: String; let viewport: Viewport; let text: String; let truncated: Bool }
struct FindResult: Codable, Sendable { let matches: [ElementInfo] }
struct PageTextResult: Codable, Sendable { let url: String; let title: String; let text: String; let truncated: Bool }
struct ScrollResult: Codable, Sendable { let moved: Bool; let viewport: Viewport }
struct TabsResult: Codable, Sendable { let tabs: [TabInfo] }
struct TabResult: Codable, Sendable { let tab: TabInfo }
struct ClosedResult: Codable, Sendable { let closed: Int }
struct ScreenshotResult: Codable, Sendable { let dataUrl: String; let tab: TabInfo }
/// json is the code's last expression as JSON, nil when it has none (undefined, a function or a symbol).
struct JavascriptResult: Codable, Sendable { let json: String? }

enum ReadFilter: String, Codable, Sendable { case interactive, all }
enum HistoryDirection: String, Codable, Sendable { case back, forward }

enum ContentRequest: Equatable, Sendable {
  case ping
  case snapshot
  case locate(ref: PageRef)
  /// watch is the ref an action targets: its frame is always read and its events carry onTarget.
  case events(clear: Bool, arm: Bool, watch: PageRef?)
  case inspect(ref: PageRef)
  /// Sets a color input from the page script, firing untrusted input and change events; answers with inspect's read-back.
  case setColor(ref: PageRef, value: String)
  /// Dispatches untrusted pointer and mouse events for the click at the element's center and focuses as a press would.
  case syntheticClick(ref: PageRef, action: ClickAction, modifiers: [KeyChord.Modifier])
  /// Gives a file input (ref, a label for one, or the only one inside ref) the files and fires untrusted input and change, or drops them on any other element.
  case upload(ref: PageRef, files: [UploadFile])
  case readPage(filter: ReadFilter, maxChars: Int, ref: PageRef?, depth: Int?)
  case find(name: String, role: String)
  case pageText(maxChars: Int)
  case scroll(ref: PageRef?, left: Double, top: Double)
  case scrollIntoView(ref: PageRef)

  var json: [String: JSONValue] {
    switch self {
    case .ping: ["op": "ping"]
    case .snapshot: ["op": "snapshot"]
    case let .locate(ref): ["op": "locate", "ref": .string(ref.description)]
    case let .events(clear, arm, watch): ["op": "events", "clear": .bool(clear), "arm": .bool(arm), "watch": watch.map { .string($0.description) } ?? .null]
    case let .inspect(ref): ["op": "inspect", "ref": .string(ref.description)]
    case let .setColor(ref, value): ["op": "setColor", "ref": .string(ref.description), "value": .string(value)]
    case let .syntheticClick(ref, action, modifiers): ["op": "syntheticClick", "ref": .string(ref.description), "action": .string(action.rawValue), "modifiers": .array(modifiers.map { .string($0.rawValue) })]
    case let .upload(ref, files): ["op": "upload", "ref": .string(ref.description), "files": .array(files.map { .object(["name": .string($0.name), "mimeType": .string($0.mimeType), "lastModified": .number($0.lastModified), "data": .string($0.data)]) })]
    case let .readPage(filter, maxChars, ref, depth): ["op": "readPage", "filter": .string(filter.rawValue), "maxChars": .number(Double(maxChars)), "ref": ref.map { .string($0.description) } ?? .null, "depth": depth.map { .number(Double($0)) } ?? .null]
    case let .find(name, role): ["op": "find", "name": .string(name), "role": .string(role)]
    case let .pageText(maxChars): ["op": "pageText", "maxChars": .number(Double(maxChars))]
    case let .scroll(ref, left, top): ["op": "scroll", "ref": ref.map { .string($0.description) } ?? .null, "left": .number(left), "top": .number(top)]
    case let .scrollIntoView(ref): ["op": "scrollIntoView", "ref": .string(ref.description)]
    }
  }
}

/// App to background; a nil tabId is sent as null, meaning the active tab of the last focused window.
enum BackgroundCommand: Equatable, Sendable {
  case content(tabId: Int?, request: ContentRequest)
  case tabs
  case tab(tabId: Int?)
  case tabCreate(url: String?, windowId: Int?)
  case tabSelect(tabId: Int)
  case tabClose(tabId: Int)
  case navigate(tabId: Int?, url: String)
  case history(tabId: Int?, direction: HistoryDirection)
  case screenshot(tabId: Int?)
  case resize(tabId: Int?, width: Int, height: Int)
  case frames(tabId: Int?)
  case javascript(tabId: Int?, code: String, frame: PageRef?)

  var json: [String: JSONValue] {
    let id = { (tabId: Int?) in tabId.map { JSONValue.number(Double($0)) } ?? .null }

    switch self {
    case let .content(tabId, request): return ["type": "content", "tabId": id(tabId), "request": .object(request.json)]
    case .tabs: return ["type": "tabs"]
    case let .tab(tabId): return ["type": "tab", "tabId": id(tabId)]
    case let .tabCreate(url, windowId): return ["type": "tabCreate", "url": url.map { .string($0) } ?? .null, "windowId": id(windowId)]
    case let .tabSelect(tabId): return ["type": "tabSelect", "tabId": id(tabId)]
    case let .tabClose(tabId): return ["type": "tabClose", "tabId": id(tabId)]
    case let .navigate(tabId, url): return ["type": "navigate", "tabId": id(tabId), "url": .string(url)]
    case let .history(tabId, direction): return ["type": "history", "tabId": id(tabId), "direction": .string(direction.rawValue)]
    case let .screenshot(tabId): return ["type": "screenshot", "tabId": id(tabId)]
    case let .resize(tabId, width, height): return ["type": "resize", "tabId": id(tabId), "width": .number(Double(width)), "height": .number(Double(height))]
    case let .frames(tabId): return ["type": "frames", "tabId": id(tabId)]
    case let .javascript(tabId, code, frame): return ["type": "javascript", "tabId": id(tabId), "code": .string(code), "frame": frame.map { .string($0.description) } ?? .null]
    }
  }

  var type: String { json["type"]?.string ?? "?" }
}
