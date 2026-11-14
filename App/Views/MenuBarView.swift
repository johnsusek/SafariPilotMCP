import AppKit
import SwiftUI

/// The menu bar extra's panel, laid out like a menu so the server switch can sit at the top.
struct MenuBarView: View {
  let model: AppModel
  @Environment(\.openWindow) private var openWindow
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    @Bindable var model = model

    VStack(alignment: .leading, spacing: 0) {
      Toggle(isOn: $model.serverEnabled) {
        Text("Enable MCP Server")
      }
      .toggleStyle(.switch)
      .padding(.horizontal, 14)
      .padding(.vertical, 8)

      Divider().padding(.vertical, 5)
      MenuRow(title: "Configure Claude Desktop") { run { model.configureClaudeDesktop() } }
      MenuRow(title: "Copy Claude Code Command") { run { model.copyClaudeCodeCommand() } }
      Divider().padding(.vertical, 5)
      MenuRow(title: "Settings…") {
        run {
          openWindow(id: "main")
          NSApp.activate()
        }
      }
      .keyboardShortcut(",")
      MenuRow(title: "About SafariPilot") {
        run {
          NSApp.orderFrontStandardAboutPanel()
          NSApp.activate()
        }
      }
      MenuRow(title: "Quit") { NSApp.terminate(nil) }
        .keyboardShortcut("q")
    }
    .padding(5)
    .frame(width: 280)
  }

  /// Closes the panel first, so an alert or window the action opens is not hidden behind it.
  private func run(_ action: @escaping @MainActor () -> Void) {
    dismiss()
    Task { @MainActor in action() }
  }
}

private struct MenuRow: View {
  let title: String
  let action: () -> Void
  @State private var hovered = false

  var body: some View {
    Button(action: action) {
      Text(title)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .foregroundStyle(hovered ? Color.white : Color.primary)
        .background(hovered ? Color.accentColor : .clear, in: .rect(cornerRadius: 5))
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovered = $0 }
  }
}
