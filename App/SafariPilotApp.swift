import AppKit
import SwiftUI

@main
struct SafariPilotApp: App {
  @NSApplicationDelegateAdaptor private var delegate: AppDelegate
  @AppStorage("showInMenuBar") private var showInMenuBar = true
  @Environment(\.openWindow) private var openWindow

  var body: some Scene {
    MenuBarExtra(isInserted: $showInMenuBar) {
      MenuBarView(model: delegate.model)
    } label: {
      Image("MenuBarLogo")
    }
    .menuBarExtraStyle(.window)
    // Lives on the scene, not a view, so reopening still works with the menu bar icon hidden.
    .onChange(of: delegate.openMain, initial: true) { _, open in
      guard open else { return }

      delegate.openMain = false
      openWindow(id: "main")
      NSApp.activate()
    }

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
@Observable final class AppDelegate: NSObject, NSApplicationDelegate {
  @MainActor let model = AppModel()
  var openMain = false

  /// The window opens at launch only while setup is unfinished, so a login or CLI launch stays out of the way.
  func applicationDidFinishLaunching(_: Notification) {
    MainActor.assumeIsolated {
      model.start()
      openMain = !model.axTrusted
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { false }

  /// Opening the app again from Finder or Spotlight shows the status window.
  func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows _: Bool) -> Bool {
    openMain = true
    return false
  }
}
