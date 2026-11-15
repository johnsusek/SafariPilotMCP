import AppKit
import SwiftUI

@main
struct SafariPilotApp: App {
  @NSApplicationDelegateAdaptor private var delegate: AppDelegate
  @AppStorage("showInMenuBar") private var showInMenuBar = true
  @Environment(\.openWindow) private var openWindow

  var body: some Scene {
    MenuBarExtra(isInserted: $showInMenuBar) {
      MenuBarMenu(model: delegate.model)
    } label: {
      Image("MenuBarLogo")
    }
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
      CommandGroup(after: .appInfo) {
        Button("Check for Updates…") { delegate.model.updates.check() }
          .disabled(!delegate.model.updates.canCheck)
      }
      CommandMenu("Bridge") {
        Button("Request Accessibility Access") { delegate.model.requestAccessibility() }
          .disabled(delegate.model.axTrusted)
        Button("Open Extension Settings") { Task { await delegate.model.openExtensionSettings() } }
        Divider()
        Button("Configure Claude Desktop…") { delegate.model.configureClaudeDesktop() }
          .disabled(delegate.model.desktopSetUp)
        Button("Copy Server Command to Clipboard") { delegate.model.copyClaudeCodeCommand() }
          .disabled(delegate.model.codeSetUp)
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

private struct MenuBarMenu: View {
  let model: AppModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    @Bindable var model = model
    Toggle("Enable MCP Server", isOn: $model.serverEnabled)
    Divider()
    Button("Configure Claude Desktop…") { model.configureClaudeDesktop() }
      .disabled(model.desktopSetUp)
    Button("Copy Server Command to Clipboard") { model.copyClaudeCodeCommand() }
      .disabled(model.codeSetUp)
    Divider()
    Button("Check for Updates…") { model.updates.check() }
      .disabled(!model.updates.canCheck)
    Button("Settings…") {
      openWindow(id: "main")
      NSApp.activate()
    }
    .keyboardShortcut(",")
    Button("About SafariPilot") {
      NSApp.orderFrontStandardAboutPanel()
      NSApp.activate()
    }
    Button("Quit SafariPilot") { NSApp.terminate(nil) }
      .keyboardShortcut("q")
  }
}
