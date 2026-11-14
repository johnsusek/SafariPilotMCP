import CoreGraphics
import Foundation

/// Builds Quartz input events and posts each one to a single pid, recording a line per event.
@AXActor
struct EventPoster {
  let pid: pid_t
  /// Written to the public window-under-pointer fields of mouse events; nil leaves them unset.
  let windowID: CGWindowID?
  private(set) var posted: [String] = []
  // A private state source keeps the user's held modifiers out of the posted events and ours out of the system-wide state.
  private let source = CGEventSource(stateID: .privateState)

  init(pid: pid_t, windowID: CGWindowID?) {
    self.pid = pid
    self.windowID = windowID
  }

  private static let names: [CGEventType: String] = [
    .keyDown: "keyDown", .keyUp: "keyUp", .flagsChanged: "flagsChanged", .mouseMoved: "mouseMoved",
    .leftMouseDown: "leftMouseDown", .leftMouseUp: "leftMouseUp", .leftMouseDragged: "leftMouseDragged",
  ]

  private static let flags: [KeyChord.Modifier: CGEventFlags] = [.cmd: .maskCommand, .shift: .maskShift, .alt: .maskAlternate, .ctrl: .maskControl]

  /// Finds the CGWindowID of the pid's normal-layer window whose bounds match the AX window frame.
  static func windowID(pid: pid_t, frame: CGRect) throws -> CGWindowID {
    let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    let matches: [(id: CGWindowID, bounds: CGRect)] = list.compactMap { window in
      guard window[kCGWindowLayer as String] as? Int == 0, window[kCGWindowOwnerPID as String] as? pid_t == pid, let id = window[kCGWindowNumber as String] as? CGWindowID else { return nil }
      guard let bounds = window[kCGWindowBounds as String].flatMap({ CGRect(dictionaryRepresentation: $0 as! CFDictionary) }) else { return nil }

      return (id, bounds)
    }
    let close = matches.filter { abs($0.bounds.minX - frame.minX) + abs($0.bounds.minY - frame.minY) + abs($0.bounds.width - frame.width) + abs($0.bounds.height - frame.height) <= 4 }

    guard close.count == 1 else {
      let listed = matches.map { "\($0.id) \(AXEngine.format($0.bounds))" }.joined(separator: ", ")
      throw Failure(.safariUnavailable, "found \(close.count) CGWindows of pid \(pid) matching AX frame \(AXEngine.format(frame)); layer-0 windows: \(listed.isEmpty ? "none" : listed)")
    }

    return close[0].id
  }

  private mutating func post(_ event: CGEvent, _ detail: String) {
    event.postToPid(pid)

    posted.append("\(Self.names[event.type] ?? "type \(event.type.rawValue)") \(detail)")
  }

  private func flagNames(_ flags: CGEventFlags) -> String {
    let names = KeyChord.Modifier.allCases.filter { flags.contains(Self.flags[$0]!) }.map(\.rawValue)
    return names.isEmpty ? "none" : names.joined(separator: "+")
  }

  private mutating func keyEvent(_ code: UInt16, down: Bool, flags: CGEventFlags, character: String?, label: String, modifier: Bool) throws {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { throw Failure(.failed, "could not create a key event for \(label)") }

    // Hardware reports modifier keys as flagsChanged, not keyDown/keyUp.
    if modifier { event.type = .flagsChanged }

    event.flags = flags

    if let character {
      let units = Array(character.utf16)
      event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    }

    let characters = character.map { " chars=\"\($0)\"" } ?? ""
    post(event, "\(label) code=\(code) \(down ? "down" : "up") flags=\(flagNames(flags))\(characters)")
  }

  mutating func key(_ chord: KeyChord) async throws {
    var flags: CGEventFlags = []

    for modifier in chord.modifiers {
      flags.insert(Self.flags[modifier]!)
      try keyEvent(modifier.keyCode, down: true, flags: flags, character: nil, label: modifier.rawValue, modifier: true)
      try await Task.sleep(for: .milliseconds(15))
    }

    try keyEvent(chord.keyCode, down: true, flags: flags, character: chord.character, label: chord.key, modifier: false)
    try await Task.sleep(for: .milliseconds(40))
    try keyEvent(chord.keyCode, down: false, flags: flags, character: chord.character, label: chord.key, modifier: false)

    for modifier in chord.modifiers.reversed() {
      try await Task.sleep(for: .milliseconds(15))
      flags.remove(Self.flags[modifier]!)
      try keyEvent(modifier.keyCode, down: false, flags: flags, character: nil, label: modifier.rawValue, modifier: true)
    }
  }

  private mutating func mouse(_ type: CGEventType, _ point: CGPoint, pressed: Bool) throws {
    guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
      throw Failure(.failed, "could not create a mouse event at \(AXEngine.format(point))")
    }

    event.setIntegerValueField(.mouseEventClickState, value: type == .mouseMoved ? 0 : 1)
    event.setDoubleValueField(.mouseEventPressure, value: pressed ? 1 : 0)

    if let windowID {
      event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
      event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
    }

    post(event, "\(AXEngine.format(point))\(windowID.map { " window=\($0)" } ?? "")")
  }

  mutating func click(at point: CGPoint) async throws {
    try mouse(.leftMouseDown, point, pressed: true)
    try await Task.sleep(for: .milliseconds(60))
    try mouse(.leftMouseUp, point, pressed: false)
  }

  /// Approaches the point diagonally over a few moves rather than teleporting onto it.
  mutating func hover(to point: CGPoint) async throws {
    for offset in [12.0, 8, 4, 0] {
      try mouse(.mouseMoved, CGPoint(x: point.x - offset, y: point.y - offset), pressed: false)
      try await Task.sleep(for: .milliseconds(30))
    }
  }

  mutating func drag(from start: CGPoint, to end: CGPoint) async throws {
    let steps = 12
    var point = start
    try mouse(.leftMouseDown, start, pressed: true)

    do {
      try await Task.sleep(for: .milliseconds(80))

      for step in 1 ... steps {
        let progress = Double(step) / Double(steps)
        point = CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress)
        try mouse(.leftMouseDragged, point, pressed: true)
        try await Task.sleep(for: .milliseconds(25))
      }
    } catch {
      // A button left down would turn the user's next mouse move into a drag.
      try? mouse(.leftMouseUp, point, pressed: false)
      throw error
    }

    try mouse(.leftMouseUp, end, pressed: false)
  }
}
