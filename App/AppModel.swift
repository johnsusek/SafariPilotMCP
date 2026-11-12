import ApplicationServices
import Foundation
import Observation
import SafariServices

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
  private(set) var axTrusted = AXIsProcessTrusted()
  private(set) var extensionEnabled: Bool?
  private(set) var extensionError: String?
  private(set) var log: [LogEntry] = []
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
        await refreshExtensionState()
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

  func runCLI(_ request: CLIRequest) async -> CLIReply {
    let commands = Commands(model: self, deadline: .now + .seconds(request.timeoutSeconds))
    let label = String(describing: request.command)

    do {
      let reply = try await commands.run(request.command)
      record(label, ok: reply.ok, summary: reply.text.components(separatedBy: "\n").first ?? "")
      return reply
    } catch {
      record(label, ok: false, summary: "\(error)")
      return CLIReply(ok: false, text: "\(error)", data: .object(["error": .string("\(error)")]))
    }
  }

  func record(_ command: String, ok: Bool, summary: String) {
    log.append(LogEntry(at: .now, command: command, ok: ok, summary: summary))
    log = Array(log.suffix(500))
  }

  func clearLog() { log.removeAll() }
}
