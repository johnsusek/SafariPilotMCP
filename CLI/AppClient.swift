import Foundation

/// Sends one command to SafariPilot.app over the loopback wire.
enum AppClient {
  /// Blocking; the socket timeout gives the app a few seconds beyond its own deadline to answer.
  static func send(_ command: AppCommand, timeout: Double) throws -> CLIReply {
    let request = try JSONEncoder().encode(CLIRequest(command: command, timeoutSeconds: timeout))
    let reply = try Wire.exchange(request, timeoutSeconds: Int(timeout) + 5)
    return try JSONDecoder().decode(CLIReply.self, from: reply)
  }
}
