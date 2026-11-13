import AppKit
import ApplicationServices

/// JavaScript dialogs: while alert(), confirm() or prompt() is open, Safari 27 replaces the tab's page view under the window's AXTabGroup with an AXGroup/AXDialog, and the page's scripts and SafariPilot's whole extension wait until it closes.
extension AXEngine {
  struct OpenDialog {
    let node: AXNode
    let dialog: JSDialog
    /// In Safari's order: Cancel then OK, or an alert's lone Close.
    let buttons: [AXNode]
    let field: AXNode?
  }

  typealias DialogScan = [(window: AXNode, dialog: AXNode?)]

  /// Every Safari window with the dialog shown in it, if any; empty while Safari is hidden, since AX reaches no windows then.
  static func scanDialogs() throws -> DialogScan {
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first, !running.isHidden else { return [] }

    return try windows(of: safari()).map { window in
      let tabGroup = window.children.first { $0.role == kAXSplitGroupRole }?.children.first { $0.role == kAXTabGroupRole }
      return (window, tabGroup?.children.first { $0.subrole == kAXDialogSubrole })
    }
  }

  /// The dialog shown over the tab, which must be the active tab of its window, since Safari shows only that tab's dialog.
  static func dialog(for tab: TabInfo, in scan: DialogScan) throws -> OpenDialog? {
    guard scan.contains(where: { $0.dialog != nil }) else { return nil }

    let index: Int

    do { index = try WindowMatching.byFrame(tab: tab, candidates: scan.map { candidate($0.window, urls: []) }) } catch { throw Failure(description: "a dialog is open in Safari, but tab \(tab.id)'s window could not be told apart: \(error.description)") }

    guard let node = scan[index].dialog else { return nil }

    let children = node.children
    let buttons = children.filter { $0.role == kAXButtonRole }
    let field = children.first { $0.role == kAXTextFieldRole }
    let message = node.string(kAXValueAttribute) ?? ""

    guard let kind = JSDialog.kind(buttons: buttons.count, textField: field != nil) else {
      throw Failure(description: "tab \(tab.id) shows a dialog SafariPilot does not recognize, \"\(message)\" with buttons \(buttons.map { "\"\($0.label)\"" }.joined(separator: ", "))\(field == nil ? "" : " and a text field")")
    }

    let origin = JSDialog.origin(fromLine: children.first { $0.role == kAXStaticTextRole }?.string(kAXValueAttribute) ?? "")
    let dialog = JSDialog(kind: kind, message: message, origin: origin, promptText: field.map { $0.string(kAXValueAttribute) ?? "" })
    return OpenDialog(node: node, dialog: dialog, buttons: buttons, field: field)
  }

  static func dialog(for tab: TabInfo) throws -> OpenDialog? { try dialog(for: tab, in: scanDialogs()) }
}

extension Commands {
  /// Safari's extension, background included, stops while any page shows a dialog and resumes once it closes (measured: a pending tabs query never answered).
  /// The message names the dialog only when it is over the given tab, so a dialog in a window the caller does not own stays private.
  func dialogBlock(_ tabId: Int?) throws -> String? {
    let scan = try AXEngine.scanDialogs()

    guard scan.contains(where: { $0.dialog != nil }) else { return nil }

    let tab = tabId.flatMap { model.knownTabs[$0] }

    if let tab, let open = try AXEngine.dialog(for: tab, in: scan) {
      return "tab \(tab.id) shows \(open.dialog.line); Safari's extension, and so every page tool, waits until handle_dialog accepts or dismisses it"
    }

    let window = switch (tabId, tab) {
    case (nil, _): "a Safari window"
    case let (id?, nil): "a Safari window not known to hold tab \(id)"
    case let (id?, _?): "a Safari window other than tab \(id)'s"
    }
    return "a dialog is open in \(window), and Safari's extension, so every tool that reaches a tab, waits until it is closed"
  }

  /// handle_dialog: optionally sets a prompt's text through AXValue, presses OK (or an alert's Close) to accept or Cancel to dismiss through AXPress, and waits up to 1 s for the dialog to close.
  /// The extension cannot answer while the dialog is open, so the tab's window is found from the TabInfo last seen for it.
  func answerDialog(_ tabId: Int?, _ accept: Bool, _ promptText: String?) async throws -> CLIReply {
    guard let tabId else { throw Failure(description: "dialog needs a tab id (--tab), since the extension that knows the active tab cannot answer while a dialog is open") }
    guard let tab = model.knownTabs[tabId] else { throw Failure(description: "SafariPilot has not seen tab \(tabId) since it started, so it cannot tell which window is the tab's") }
    guard let open = try AXEngine.dialog(for: tab) else { throw Failure(description: "no dialog is open in tab \(tab.id)'s window") }

    var lines: [String] = []

    if let promptText {
      guard let field = open.field else { throw Failure(description: "prompt_text applies only to a prompt, and tab \(tab.id) shows \(open.dialog.line); nothing was pressed") }

      let result = AXUIElementSetAttributeValue(field.element, kAXValueAttribute as CFString, promptText as CFString)
      let shown = field.string(kAXValueAttribute) ?? ""

      guard result == .success, shown == promptText else { throw Failure(description: "AXValue on the prompt's text field returned \(result.name) and it reads \"\(shown)\", not \"\(promptText)\"; nothing was pressed") }

      lines.append("typed \"\(promptText)\" into the prompt")
    }

    let button = accept ? open.buttons[open.buttons.count - 1] : open.buttons[0]
    let title = button.label
    let pressed = AXUIElementPerformAction(button.element, kAXPressAction as CFString)

    guard pressed == .success else { throw Failure(description: "AXPress on the dialog's \"\(title)\" button failed: \(pressed.name)") }

    // A page can open another dialog as soon as this one closes, which shows as a different dialog element.
    // Seen live: a press while the dialog is still appearing in a fully covered window leaves the button highlighted (AXValue 1) with its action pending until the next press, so a stuck button is pressed once more.
    var next: AXEngine.OpenDialog?
    var pressedAgain = false

    for attempt in 1 ... 20 {
      try await Task.sleep(for: .milliseconds(50))
      next = try AXEngine.dialog(for: tab)

      guard let still = next, CFEqual(still.node.element, open.node.element) else { break }

      if attempt == 6, button.value(kAXValueAttribute) as? Int == 1 { pressedAgain = AXUIElementPerformAction(button.element, kAXPressAction as CFString) == .success }
    }

    if let next, CFEqual(next.node.element, open.node.element) { throw Failure(description: "pressed \"\(title)\"\(pressedAgain ? " twice" : "") but \(open.dialog.line) is still open after 1 s") }

    lines.append("\(accept ? "accepted" : "dismissed") \(open.dialog.line) by pressing \"\(title)\"\(pressedAgain ? " twice, as the first press stuck while the dialog appeared," : "") in tab \(tab.id)")

    if let next { lines.append("then the page opened \(next.dialog.line)") }

    let data: JSONValue = try .object(["tabId": .number(Double(tab.id)), "dialog": JSONValue(encoding: open.dialog), "accepted": .bool(accept), "button": .string(title), "pressedAgain": .bool(pressedAgain), "next": JSONValue(encoding: next?.dialog)])
    return CLIReply(ok: true, text: lines.joined(separator: "\n"), data: data)
  }
}
