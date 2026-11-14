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

  let transport = Transport()
  /// The build stamped into the app extension this app embeds, read once at launch, since an install replaces the bundle under a running app.
  let build = BuildIdentity.read(appex: Bundle.main.builtInPlugInsURL!.appending(path: "SafariPilotExtension.appex"))
  /// What the last background message said about the extension Safari runs; nil until one arrives.
  private(set) var extensionBuild: ExtensionBuild?
  let gate = ClientGate()
  private let queue = CommandQueue()
  private(set) var axTrusted = AXIsProcessTrusted()
  private(set) var extensionEnabled: Bool?
  private(set) var extensionError: String?
  private(set) var desktopAdded = false
  private(set) var loginItem = SMAppService.mainApp.status
  /// Off refuses every MCP client and every command but status, while the app keeps running.
  var serverEnabled = UserDefaults.standard.object(forKey: "serverEnabled") as? Bool ?? true {
    didSet { UserDefaults.standard.set(serverEnabled, forKey: "serverEnabled") }
  }
  static let serverOff = "SafariPilot's MCP server is turned off; turn on Enable MCP Server in its menu bar menu."

  private(set) var log: [LogEntry] = []
  /// The last TabInfo each background reply carried, for finding a tab's window while a dialog keeps the extension from answering.
  private(set) var knownTabs: [Int: TabInfo] = [:]
  private var started = false
  /// Commands that may touch Safari, running or recently ended, for naming the one that brought Safari forward.
  private var inFlight: [UUID: (label: String, start: Date)] = [:]
  private var lastEnded: (label: String, start: Date, end: Date)?

  var buildMismatch: BuildMismatch? { extensionBuild?.mismatch(app: build) }

  var extensionState: String {
    if let extensionError { return "unknown (\(extensionError))" }
    guard let extensionEnabled else { return "unknown" }
    return extensionEnabled ? "enabled" : "disabled"
  }

  func start() {
    guard !started else { return }

    started = true
    Task { await Server.run(model: self) }
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      guard app?.bundleIdentifier == "com.apple.Safari" else { return }

      MainActor.assumeIsolated { self.noteSafariActivated() }
    }
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
      alert("Couldn't Change Launch at Login", error.localizedDescription)
    }

    loginItem = SMAppService.mainApp.status
  }

  /// After a confirmation, writes this app's server into Claude Desktop's config; a config that is not a JSON object is refused, not overwritten.
  func configureClaudeDesktop() {
    let url = ClaudeSetup.desktopConfigURL
    let confirm = NSAlert()
    confirm.messageText = "Set Up SafariPilot Server"
    confirm.informativeText = "Adds SafariPilot to Claude Desktop's settings, with a credential that identifies Claude Desktop to SafariPilot. Your other servers stay as they are.\n\n\(url.path)"
    confirm.addButton(withTitle: "Set Up")
    confirm.addButton(withTitle: "Cancel")
    NSApp.activate()
    guard confirm.runModal() == .alertFirstButtonReturn else { return }

    do {
      let existing = FileManager.default.fileExists(atPath: url.path) ? try Data(contentsOf: url) : nil
      let credential = try gate.credentialForSettings(name: "Claude Desktop", existing: ClaudeSetup.credential(in: existing))
      let merged = try ClaudeSetup.merged(config: existing, serverPath: ClaudeSetup.serverPath, credential: credential)
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try merged.write(to: url, options: .atomic)
      desktopAdded = true
      alert("Added to Claude Desktop", "Quit and reopen Claude to load SafariPilot.")
    } catch {
      alert("Couldn't Update Claude Desktop", "\(error)")
    }
  }

  /// Copies the command with a new untrusted credential, to this Mac only since it holds a secret.
  func copyClaudeCodeCommand() {
    do {
      let credential = try gate.credentialForSettings(name: "Claude Code", existing: nil)
      NSPasteboard.general.prepareForNewContents(with: .currentHostOnly)
      NSPasteboard.general.setString(ClaudeSetup.codeCommand(serverPath: ClaudeSetup.serverPath, credential: credential), forType: .string)
    } catch {
      alert("Couldn't Create a Credential", "\(error)")
    }
  }

  /// App-modal, since a menu bar action has no window to put a sheet on.
  private func alert(_ title: String, _ message: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = message
    NSApp.activate()
    alert.runModal()
  }

  func runCLI(_ request: CLIRequest) async -> CLIReply {
    let label = request.command.logLabel

    if !serverEnabled, request.command != .status {
      record(label, ok: false, summary: "refused: MCP server is off")
      return CLIReply(failed: Failure(.appUnavailable, AppModel.serverOff))
    }

    if let refusal = gate.refusal(for: request) {
      record(label, ok: false, summary: "\(refusal.code.rawValue): \(refusal)")
      return CLIReply(failed: refusal)
    }

    if request.command != .status, let buildMismatch {
      record(label, ok: false, summary: "\(ErrorCode.buildMismatch.rawValue): \(buildMismatch)")
      return CLIReply(failed: buildMismatch)
    }

    let commands = Commands(model: self, deadline: .now + .seconds(request.timeoutSeconds))
    let id = UUID()

    if case .status = request.command {} else { inFlight[id] = (label, .now) }

    defer {
      if let entry = inFlight.removeValue(forKey: id) { lastEnded = (entry.label, entry.start, .now) }
    }

    do {
      // status only reads app state, and handle_dialog only presses a dialog's button, which must not wait behind a command the dialog holds up.
      let reply = switch request.command {
      case .status, .dialog: try await commands.run(request.command)
      default: try await queue.run { try await commands.run(request.command) }
      }
      let summary = reply.text.components(separatedBy: "\n").first ?? ""
      record(label, ok: reply.ok, summary: reply.code.map { "\($0.rawValue): \(summary)" } ?? summary)
      return reply.forClient
    } catch {
      record(label, ok: false, summary: "\(ErrorCode(of: error).rawValue): \(error)")
      return CLIReply(failed: error).forClient
    }
  }

  /// Every background message names the builds Safari runs; a poll from any build but this app's gets the mismatch instead of a command, and so do commands waiting for one.
  func relay(_ message: JSONValue, poll: UUID) async -> JSONValue {
    let seen = ExtensionBuild(message: message)

    if seen != extensionBuild {
      extensionBuild = seen
      let mismatch = seen.mismatch(app: build)
      record("extension build", ok: mismatch == nil, summary: mismatch.map { "\($0)" } ?? "matches this app, \(build ?? "")")
    }

    return await transport.handle(message, poll: poll, refusal: buildMismatch)
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

  /// Logs Safari coming to the front during a command or within 2 s of one ending; outside that window it is taken as the user's own switch.
  private func noteSafariActivated() {
    let now = Date.now
    let seconds = { (from: Date) in (now.timeIntervalSince(from)).formatted(.number.precision(.fractionLength(2))) }

    if let running = inFlight.values.min(by: { $0.start < $1.start }) {
      record("Safari came forward", ok: false, summary: "\(seconds(running.start)) s into \(running.label)")
      return
    }

    guard let ended = lastEnded, now.timeIntervalSince(ended.end) < 2 else { return }

    record("Safari came forward", ok: false, summary: "\(seconds(ended.end)) s after \(ended.label) ended (\(seconds(ended.start)) s after it started)")
  }

  func record(_ command: String, ok: Bool, summary: String) {
    log.append(LogEntry(at: .now, command: command, ok: ok, summary: summary))
    log = Array(log.suffix(500))
  }

  func clearLog() { log.removeAll() }
}
