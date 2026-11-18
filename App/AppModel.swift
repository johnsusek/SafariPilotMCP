import AppKit
import ApplicationServices
import Foundation
import Observation
import SafariServices
import ServiceManagement

@Observable @MainActor
final class AppModel {
  struct LogEntry: Identifiable, Codable {
    var id = UUID()
    let at: Date
    let command: String
    let ok: Bool
    let summary: String
    var timing: CommandTiming?
  }

  let transport = Transport()
  /// The build stamped into the app extension this app embeds, read once at launch, since an install replaces the bundle under a running app.
  let build = BuildIdentity.read(appex: Bundle.main.builtInPlugInsURL!.appending(path: "SafariPilotExtension.appex"))
  /// What the last background message said about the extension Safari runs; nil until one arrives.
  private(set) var extensionBuild: ExtensionBuild?
  let gate = ClientGate()
  let updates = Updates()
  private let queue = CommandQueue()
  private(set) var axTrusted = AXIsProcessTrusted()
  private(set) var extensionEnabled: Bool?
  private(set) var extensionError: String?
  /// The clients whose config already runs SafariPilot from any source.
  private(set) var configured: Set<ClientSetup.Client> = []
  private(set) var loginItem = SMAppService.mainApp.status

  private(set) var log: [LogEntry] = []
  /// Off refuses every MCP client and every command but status, while the app keeps running.
  var serverEnabled = UserDefaults.standard.object(forKey: "serverEnabled") as? Bool ?? true {
    didSet { UserDefaults.standard.set(serverEnabled, forKey: "serverEnabled") }
  }
  /// Keeps the log on disk across launches, capped like the in-memory one.
  var retainLog = UserDefaults.standard.bool(forKey: "retainLog") {
    didSet {
      UserDefaults.standard.set(retainLog, forKey: "retainLog")

      if retainLog { saveLog() } else { try? FileManager.default.removeItem(at: Self.logURL) }
    }
  }
  static let logURL = URL.applicationSupportDirectory.appending(path: "SafariPilot/activity.json")
  private var saveTask: Task<Void, Never>?
  static let serverOff = "SafariPilot's MCP server is turned off; turn on Enable MCP Server in its menu bar menu."

  /// The last TabInfo each background reply carried, for finding a tab's window while a dialog keeps the extension from answering.
  private(set) var knownTabs: [Int: TabInfo] = [:]
  /// Which tabs each session owns; Commands reads and updates it.
  var sessionTabs = SessionTabs()
  /// The sessions alive at the last check, so one ending (its process exited or the person disconnected it) closes its tabs.
  private var liveSessions: Set<String> = []
  private var closedLeftovers = false
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

    if retainLog, let data = try? Data(contentsOf: Self.logURL) {
      do { log = try JSONDecoder().decode([LogEntry].self, from: data) + log } catch { record("load log", ok: false, summary: "\(error)") }
    }

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
        let live = Set(gate.sessions.map(\.id))

        if !liveSessions.isSubset(of: live) { Task { await closeOrphans() } }

        liveSessions = live
        refreshSetUp()
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }

  private func refreshSetUp() {
    let read = { (url: URL) in try? Data(contentsOf: url) }
    let resolve = { (path: String) in URL(filePath: path).resolvingSymlinksInPath().path }
    let path = ClientSetup.serverPath
    let knows = { (credential: String) in self.gate.knows(credential: credential) }

    configured = Set(ClientSetup.Client.allCases.filter { client in
      if let json = client.json { return ClientSetup.hasServer(config: read(json.url), key: json.key, serverPath: path, resolve: resolve, knows: knows) }

      if client == .claudeCode { return ClientSetup.codeHasServer(config: read(ClientSetup.codeConfigURL), serverPath: path, resolve: resolve) }

      return ClientSetup.codexHasServer(config: read(ClientSetup.codexConfigURL), serverPath: path, resolve: resolve, knows: knows)
    })
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

  func setUp(_ client: ClientSetup.Client) {
    if let json = client.json { return configure(client, json) }

    if client == .claudeCode { return copy(name: client.rawValue) { ClientSetup.codeCommand(serverPath: ClientSetup.serverPath, credential: $0) } }

    Task { await configureCodex() }
  }

  private func confirmed(_ client: ClientSetup.Client, _ path: String) -> Bool {
    let confirm = NSAlert()
    confirm.messageText = "Set Up SafariPilot Server"
    confirm.informativeText = "Adds SafariPilot to \(client.rawValue)'s settings, with a credential that identifies it to SafariPilot. Your other servers stay as they are.\n\n\(path)"
    confirm.addButton(withTitle: "Set Up")
    confirm.addButton(withTitle: "Cancel")
    NSApp.activate()
    return confirm.runModal() == .alertFirstButtonReturn
  }

  /// After a confirmation, writes this app's server into the client's JSON config; a config that is not a JSON object is refused, not overwritten.
  private func configure(_ client: ClientSetup.Client, _ json: ClientSetup.JSONConfig) {
    guard confirmed(client, json.url.path) else { return }

    do {
      let existing = FileManager.default.fileExists(atPath: json.url.path) ? try Data(contentsOf: json.url) : nil
      let credential = try gate.credentialForSettings(name: client.rawValue, existing: ClientSetup.credential(in: existing, key: json.key))
      let merged = try ClientSetup.merged(config: existing, in: json, serverPath: ClientSetup.serverPath, credential: credential)
      try FileManager.default.createDirectory(at: json.url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try merged.write(to: json.url, options: .atomic)
      configured.insert(client)
      alert("Added to \(client.rawValue)", "Quit and reopen \(client.rawValue) to load SafariPilot.")
    } catch {
      alert("Couldn't Update \(client.rawValue)", "\(error)")
    }
  }

  /// Runs ChatGPT's bundled codex, or the one the login shell finds, so Codex writes its own TOML.
  private func configureCodex() async {
    guard let codex = await codexPath() else { return alert("Codex Not Found", "Install ChatGPT or the Codex CLI, then try again.") }

    guard confirmed(.codex, ClientSetup.codexConfigURL.path) else { return }

    do {
      let existing = ClientSetup.codexServers(toml: try? Data(contentsOf: ClientSetup.codexConfigURL))[ClientSetup.serverName]?.credential
      let credential = try gate.credentialForSettings(name: ClientSetup.Client.codex.rawValue, existing: existing)
      let (status, output) = try await run(codex, ClientSetup.codexArguments(serverPath: ClientSetup.serverPath, credential: credential))

      guard status == 0 else { return alert("Couldn't Update ChatGPT and Codex", "codex exited with status \(status).\n\n\(output)") }

      configured.insert(.codex)
      alert("Added to ChatGPT and Codex", "Quit and reopen ChatGPT, or start a new Codex session, to load SafariPilot.")
    } catch {
      alert("Couldn't Update ChatGPT and Codex", "\(error)")
    }
  }

  private func codexPath() async -> String? {
    if FileManager.default.isExecutableFile(atPath: ClientSetup.bundledCodex) { return ClientSetup.bundledCodex }

    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    guard let (status, output) = try? await run(shell, ["-lc", "command -v codex"]), status == 0 else { return nil }

    let path = output.trimmingCharacters(in: .whitespacesAndNewlines)
    return FileManager.default.isExecutableFile(atPath: path) ? path : nil
  }

  /// Runs a tool to completion and returns its status with stdout and stderr together.
  private func run(_ path: String, _ arguments: [String]) async throws -> (Int32, String) {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(filePath: path)
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = pipe
    process.standardInput = FileHandle.nullDevice

    let status = try await withCheckedThrowingContinuation { continuation in
      process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }

      do { try process.run() } catch { continuation.resume(throwing: error) }
    }

    return (status, String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
  }

  /// Copies a standard mcpServers entry for any other client.
  func copyConfigJSON() {
    copy(name: "Other Client") { try ClientSetup.snippet(serverPath: ClientSetup.serverPath, credential: $0) }
  }

  /// Copies text holding a new untrusted credential, to this Mac only since it holds a secret.
  private func copy(name: String, _ text: (String) throws -> String) {
    do {
      let value = try text(gate.credentialForSettings(name: name, existing: nil))
      NSPasteboard.general.prepareForNewContents(with: .currentHostOnly)
      NSPasteboard.general.setString(value, forType: .string)
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

    let commands = Commands(model: self, session: request.session ?? "", deadline: .now + .seconds(request.timeoutSeconds))
    let id = UUID()

    if case .status = request.command {} else { inFlight[id] = (label, .now) }

    defer {
      if let entry = inFlight.removeValue(forKey: id) { lastEnded = (entry.label, entry.start, .now) }
    }

    let timing = Timing()
    let queued = ContinuousClock.now

    do {
      // status only reads app state, and handle_dialog only presses a dialog's button, which must not wait behind a command the dialog holds up.
      var reply = try await Timing.$current.withValue(timing) {
        switch request.command {
        case .status, .dialog: try await commands.run(request.command)
        default:
          try await queue.run {
            timing.add("queue", .now - queued)
            return try await commands.run(request.command)
          }
        }
      }
      reply.timing = timing.finished
      let summary = reply.text.components(separatedBy: "\n").first ?? ""
      record(label, ok: reply.ok, summary: reply.code.map { "\($0.rawValue): \(summary)" } ?? summary, timing: reply.timing)
      return reply.forClient
    } catch {
      var reply = CLIReply(failed: error)
      reply.timing = timing.finished
      record(label, ok: false, summary: "\(ErrorCode(of: error).rawValue): \(error)", timing: reply.timing)
      return reply.forClient
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

    // The first message after launch: pilot tabs left from before belong to no session now.
    if !closedLeftovers {
      closedLeftovers = true
      Task { await closeOrphans() }
    }

    return await transport.handle(message, poll: poll, refusal: buildMismatch)
  }

  /// Closes the tabs of sessions that ended, through the queue so it never lands between another command's steps.
  private func closeOrphans() async {
    do {
      let closed = try await queue.run {
        let commands = Commands(model: self, session: "", deadline: .now + .seconds(CLIRequest.defaultTimeout))
        return try await commands.closeOrphans(live: Set(gate.sessions.map(\.id)).union([""]))
      }

      if !closed.isEmpty { record("close ended sessions' tabs", ok: true, summary: "closed \(closed.map(String.init).joined(separator: ", "))") }
    } catch {
      record("close ended sessions' tabs", ok: false, summary: "\(ErrorCode(of: error).rawValue): \(error)")
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

  func record(_ command: String, ok: Bool, summary: String, timing: CommandTiming? = nil) {
    log.append(LogEntry(at: .now, command: command, ok: ok, summary: summary, timing: timing))
    log = Array(log.suffix(500))
    scheduleSave()
  }

  func clearLog() {
    log.removeAll()
    scheduleSave()
  }

  /// Writes at most every two seconds, since an agent can record several commands a second.
  private func scheduleSave() {
    guard retainLog, saveTask == nil else { return }

    saveTask = Task {
      try? await Task.sleep(for: .seconds(2))
      saveTask = nil
      saveLog()
    }
  }

  func saveLog() {
    guard retainLog else { return }

    do {
      try FileManager.default.createDirectory(at: Self.logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      try JSONEncoder().encode(log).write(to: Self.logURL, options: .atomic)
    } catch {
      // Appended directly, since record would schedule another save that fails the same way.
      log.append(LogEntry(at: .now, command: "save log", ok: false, summary: "\(error)"))
    }
  }
}
