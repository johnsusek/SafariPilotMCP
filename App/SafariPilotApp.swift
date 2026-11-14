import AppKit
import SwiftUI

@main
struct SafariPilotApp: App {
  @NSApplicationDelegateAdaptor private var delegate: AppDelegate

  var body: some Scene {
    MenuBarExtra {
      MenuBarView(model: delegate.model)
    } label: {
      MenuBarIcon(model: delegate.model)
    }
    .menuBarExtraStyle(.window)

    Window("SafariPilot", id: "main") {
      MainView(model: delegate.model)
    }
    .defaultSize(width: 780, height: 580)
    .defaultLaunchBehavior(.suppressed)
    .commands {
      CommandMenu("Bridge") {
        Button("Request Accessibility Access") { delegate.model.requestAccessibility() }
          .disabled(delegate.model.axTrusted)
        Button("Open Extension Settings") { Task { await delegate.model.openExtensionSettings() } }
        Divider()
        Button("Configure Claude Desktop…") { delegate.model.configureClaudeDesktop() }
        Button("Copy Claude Code Command") { delegate.model.copyClaudeCodeCommand() }
        Divider()
        Button("Clear Log") { delegate.model.clearLog() }
          .keyboardShortcut("k")
          .disabled(delegate.model.log.isEmpty)
      }
    }
  }
}

/// Lives in the menu bar with no Dock icon; the bridge must keep serving the CLI with the status window closed.
final class AppDelegate: NSObject, NSApplicationDelegate {
  @MainActor let model = AppModel()
  static let reopen = Notification.Name("SafariPilotReopen")

  func applicationDidFinishLaunching(_: Notification) {
    MainActor.assumeIsolated { model.start() }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { false }

  /// Opening the app again from Finder or Spotlight shows the status window.
  func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows _: Bool) -> Bool {
    NotificationCenter.default.post(name: Self.reopen, object: nil)
    return false
  }
}

/// The label stays rendered for the app's lifetime, so it is where a reopen can reach openWindow.
private struct MenuBarIcon: View {
  let model: AppModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    Image("MenuBarLogo")
      .onReceive(NotificationCenter.default.publisher(for: AppDelegate.reopen)) { _ in
        openWindow(id: "main")
        NSApp.activate()
      }
      // The window opens at launch only while setup is unfinished, so a login or CLI launch stays out of the way.
      .task {
        guard !model.axTrusted else { return }

        openWindow(id: "main")
        NSApp.activate()
      }
  }
}
