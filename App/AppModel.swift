import AppKit
import ApplicationServices
import Foundation
import Observation
import SafariServices
import ServiceManagement

@Observable @MainActor
final class AppModel {
  struct LogEntry: Identifiable {
    let id = UUID()
    let at: Date
    let command: String
    let ok: Bool
    let summary: String
  }

  struct SetupAlert {
    let title: String
    let message: String
  }

  let transport = Transport()
  let gate = ClientGate()
  private let queue = CommandQueue()
  private(set) var axTrusted = AXIsProcessTrusted()
  private(set) var extensionEnabled: Bool?
  private(set) var extensionError: String?
  private(set) var desktopAdded = false
  private(set) var loginItem = SMAppService.mainApp.status
  var setupAlert: SetupAlert?
  private(set) var log: [LogEntry] = []
  /// The last TabInfo each background reply carried, for finding a tab's window while a dialog keeps the extension from answering.
  private(set) var knownTabs: [Int: TabInfo] = [:]
  private var started = false

  var extensionState: String {
    if let extensionError { return "unknown (\(extensionError))" }
    guard let extensionEnabled else { return "unknown" }
    return extensionEnabled ? "enabled" : "disabled"
  }

  func start() {
    guard !started else { return }

    started = true
    Task { await Server.run(model: self) }
    Task {
      while true {
        axTrusted = AXIsProcessTrusted()
        loginItem = SMAppService.mainApp.status
        await refreshExtensionState()
        gate.dropExited()
        desktopAdded = ClaudeSetup.isAdded(config: try? Data(contentsOf: ClaudeSetup.desktopConfigURL), serverPath: ClaudeSetup.serverPath) { gate.knows(credential: $0) }
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }

  func refreshExtensionState() async {
    do {
      extensionEnabled = try await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: Transport.extensionId).isEnabled
      extensionError = nil
    } catch {
      extensionError = error.localizedDescription
    }
  }

  func requestAccessibility() {
    axTrusted = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
  }

  func openExtensionSettings() async {
    do {
      try await SFSafariApplication.showPreferencesForExtension(withIdentifier: Transport.extensionId)
    } catch {
      record("open settings", ok: false, summary: error.localizedDescription)
    }
  }

  func setLaunchAtLogin(_ enabled: Bool) {
    do {
      if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    } catch {
      setupAlert = SetupAlert(title: "Couldn't Change Launch at Login", message: error.localizedDescription)
    }

    loginItem = SMAppService.mainApp.status
  }

  /// Writes this app's server into Claude Desktop's config; a config that is not a JSON object is refused, not overwritten.
  func addToClaudeDesktop() {
    let url = ClaudeSetup.desktopConfigURL

    do {
      let existing = FileManager.default.fileExists(atPath: url.path) ? try Data(contentsOf: url) : nil
      let credential = try gate.credentialForSettings(name: "Claude Desktop", existing: ClaudeSetup.credential(in: existing))
      let merged = try ClaudeSetup.merged(config: existing, serverPath: ClaudeSetup.serverPath, credential: credential)
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try merged.write(to: url, options: .atomic)
      desktopAdded = true
      setupAlert = SetupAlert(title: "Added to Claude Desktop", message: "Quit and reopen Claude to load SafariPilot.")
    } catch {
      setupAlert = SetupAlert(title: "Couldn't Update Claude Desktop", message: "\(error)")
    }
  }

  /// Copies the command with a new untrusted credential, to this Mac only since it holds a secret.
  func copyClaudeCodeCommand() {
    do {
      let credential = try gate.credentialForSettings(name: "Claude Code", existing: nil)
      NSPasteboard.general.prepareForNewContents(with: .currentHostOnly)
      NSPasteboard.general.setString(ClaudeSetup.codeCommand(serverPath: ClaudeSetup.serverPath, credential: credential), forType: .string)
    } catch {
      setupAlert = SetupAlert(title: "Couldn't Create a Credential", message: "\(error)")
    }
  }

  func runCLI(_ request: CLIRequest) async -> CLIReply {
    let label = request.command.logLabel

    if let refusal = gate.refusal(for: request) {
      record(label, ok: false, summary: refusal)
      return CLIReply(ok: false, text: refusal, data: .object(["unapproved": .bool(true)]))
    }

    let commands = Commands(model: self, deadline: .now + .seconds(request.timeoutSeconds))

    do {
      // status only reads app state, and handle_dialog only presses a dialog's button, which must not wait behind a command the dialog holds up.
      let reply = switch request.command {
      case .status, .dialog: try await commands.run(request.command)
      default: try await queue.run { try await commands.run(request.command) }
      }
      record(label, ok: reply.ok, summary: reply.text.components(separatedBy: "\n").first ?? "")
      return reply
    } catch {
      record(label, ok: false, summary: "\(error)")
      return CLIReply(ok: false, text: "\(error)", data: .object(["error": .string("\(error)")]))
    }
  }

  /// Keeps the TabInfo a background reply carried and forgets a closed tab.
  func noteTabs(in response: JSONValue) throws {
    if let value = response["tab"] {
      let tab = try value.decode(TabInfo.self)
      knownTabs[tab.id] = tab
    }

    if let tabs = response["tabs"] { knownTabs = try Dictionary(uniqueKeysWithValues: tabs.decode([TabInfo].self).map { ($0.id, $0) }) }

    if let closed = response["closed"]?.number { knownTabs[Int(closed)] = nil }
  }

  func record(_ command: String, ok: Bool, summary: String) {
    log.append(LogEntry(at: .now, command: command, ok: ok, summary: summary))
    log = Array(log.suffix(500))
  }

  func clearLog() { log.removeAll() }
}
