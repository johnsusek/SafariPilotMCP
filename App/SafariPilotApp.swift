import AppKit
import SwiftUI

@main
struct SafariPilotApp: App {
  @NSApplicationDelegateAdaptor private var delegate: AppDelegate

  var body: some Scene {
    Window("SafariPilot", id: "main") {
      StatusView(model: delegate.model)
    }
    .defaultSize(width: 720, height: 520)
    .commands {
      CommandMenu("Bridge") {
        Button("Request Accessibility Access") { delegate.model.requestAccessibility() }
          .disabled(delegate.model.axTrusted)
        Button("Open Extension Settings") { Task { await delegate.model.openExtensionSettings() } }
        Divider()
        Button("Clear Log") { delegate.model.clearLog() }
          .keyboardShortcut("k")
          .disabled(delegate.model.log.isEmpty)
      }
    }
  }
}

/// The bridge must keep serving the CLI with the status window closed, so the app outlives its window.
final class AppDelegate: NSObject, NSApplicationDelegate {
  @MainActor let model = AppModel()

  func applicationDidFinishLaunching(_: Notification) {
    MainActor.assumeIsolated { model.start() }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { false }
}
