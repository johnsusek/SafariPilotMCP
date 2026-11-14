import AppKit
import SwiftUI

@main
struct SafariPilotApp: App {
  @NSApplicationDelegateAdaptor private var delegate: AppDelegate

  var body: some Scene {
    MenuBarExtra {
      MenuBarMenu(model: delegate.model)
    } label: {
      MenuBarIcon(model: delegate.model)
    }

    Window("SafariPilot", id: "main") {
      MainView(model: delegate.model)
    }
    .defaultSize(width: 780, height: 580)
    .defaultLaunchBehavior(.suppressed)
    .commands {
      CommandMenu("Bridge") {
        BridgeCommands(model: delegate.model)
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

struct BridgeCommands: View {
  let model: AppModel

  var body: some View {
    Button("Request Accessibility Access") { model.requestAccessibility() }
      .disabled(model.axTrusted)
    Button("Open Extension Settings") { Task { await model.openExtensionSettings() } }
    Divider()
    Button("Add to Claude Desktop") { model.addToClaudeDesktop() }
      .disabled(model.desktopAdded)
    Button("Copy Claude Code Command") { model.copyClaudeCodeCommand() }
  }
}

private struct MenuBarMenu: View {
  let model: AppModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    Text(model.transport.listening ? "Bridge Running" : "Bridge Down")
    Button("Open SafariPilot") {
      openWindow(id: "main")
      NSApp.activate()
    }
    Divider()
    BridgeCommands(model: model)
    Divider()
    Button("Quit SafariPilot") { NSApp.terminate(nil) }
      .keyboardShortcut("q")
  }
}

/// The label stays rendered for the app's lifetime, so it is where a reopen can reach openWindow.
private struct MenuBarIcon: View {
  let model: AppModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    Image(nsImage: logo)
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

  private var logo: NSImage {
    let image = NSImage(named: "Logo")!.copy() as! NSImage
    image.size = NSSize(width: 33, height: 16)
    image.isTemplate = true
    return image
  }
}
