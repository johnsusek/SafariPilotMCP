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
  let ref: Int
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
  let ref: Int?
  let target: String
  let time: Double
  let detail: String
  let count: Int
}

struct PingResult: Codable, Sendable { let url: String; let title: String }
struct SnapshotResult: Codable, Sendable { let url: String; let title: String; let viewport: Viewport; let elements: [ElementInfo] }
struct LocateResult: Codable, Sendable { let ref: Int; let rect: CSSRect; let point: CSSPoint; let hitsTarget: Bool; let hitDescription: String; let viewport: Viewport }
/// origin is the page's performance.timeOrigin; a different origin between two reads means the page navigated or reloaded.
struct EventsResult: Codable, Sendable { let events: [LoggedEvent]; let origin: Double }
/// listbox is a select shown as a list (multiple or size over 1); date, time and datetime-local are inputs WebKit draws as separate typed fields; checked is set for checkbox and radio, selectedIndex and options for both select kinds.
enum ControlKind: String, Codable, Sendable { case text, checkbox, radio, select, listbox, date, time, dateTimeLocal = "datetime-local", other }
struct SelectOption: Codable, Sendable, Equatable { let value: String; let label: String; let disabled: Bool }
struct InspectResult: Codable, Sendable {
  let ref: Int
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

enum ReadFilter: String, Codable, Sendable { case interactive, all }
enum HistoryDirection: String, Codable, Sendable { case back, forward }

enum ContentRequest: Equatable, Sendable {
  case ping
  case snapshot
  case locate(ref: Int)
  case events(clear: Bool, arm: Bool)
  case inspect(ref: Int)
  case readPage(filter: ReadFilter, maxChars: Int, ref: Int?, depth: Int?)
  case find(name: String, role: String)
  case pageText(maxChars: Int)
  case scroll(ref: Int?, left: Double, top: Double)
  case scrollIntoView(ref: Int)

  var json: [String: JSONValue] {
    switch self {
    case .ping: ["op": "ping"]
    case .snapshot: ["op": "snapshot"]
    case let .locate(ref): ["op": "locate", "ref": .number(Double(ref))]
    case let .events(clear, arm): ["op": "events", "clear": .bool(clear), "arm": .bool(arm)]
    case let .inspect(ref): ["op": "inspect", "ref": .number(Double(ref))]
    case let .readPage(filter, maxChars, ref, depth): ["op": "readPage", "filter": .string(filter.rawValue), "maxChars": .number(Double(maxChars)), "ref": ref.map { .number(Double($0)) } ?? .null, "depth": depth.map { .number(Double($0)) } ?? .null]
    case let .find(name, role): ["op": "find", "name": .string(name), "role": .string(role)]
    case let .pageText(maxChars): ["op": "pageText", "maxChars": .number(Double(maxChars))]
    case let .scroll(ref, left, top): ["op": "scroll", "ref": ref.map { .number(Double($0)) } ?? .null, "left": .number(left), "top": .number(top)]
    case let .scrollIntoView(ref): ["op": "scrollIntoView", "ref": .number(Double(ref))]
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
    }
  }

  var type: String { json["type"]?.string ?? "?" }
}
