import AppKit
import Foundation

/// Sends one command to SafariPilot.app over the loopback wire, starting the app first when it is not running.
enum AppClient {
  static let bundleId = "net.johnsolo.SafariPilot"
  static let launchSeconds = 15.0

  /// Blocking; the socket timeout gives the app a few seconds beyond its own deadline to answer.
  static func send(_ command: AppCommand, timeout: Double, session: String? = nil) throws -> CLIReply {
    let request = try JSONEncoder().encode(CLIRequest(command: command, timeoutSeconds: timeout, session: session))
    let reply = try withApp { try Wire.exchange(request, timeoutSeconds: Int(timeout) + 5) }
    return try JSONDecoder().decode(CLIReply.self, from: reply)
  }

  /// Blocking until the person answers the approval dialog; returns the session key or throws why not.
  static func hello(clientName: String, clientVersion: String, credential: String?) throws -> String {
    let request = try JSONEncoder().encode(HelloRequest(clientName: clientName, clientVersion: clientVersion, credential: credential, pid: ProcessInfo.processInfo.processIdentifier))
    return try JSONDecoder().decode(HelloReply.self, from: withApp { try Wire.exchange(request, timeoutSeconds: HelloRequest.timeoutSeconds) }).approvedSession
  }

  /// Runs the exchange, and when the app is not running launches the copy this CLI ships in, in the background, then retries
  /// until it listens with its new token. An app_unavailable failure leaves before the app reads a command, so retrying runs nothing twice.
  private static func withApp(_ exchange: () throws -> Data) throws -> Data {
    guard NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).isEmpty else { return try exchange() }

    try launch()
    let deadline = Date.now + launchSeconds

    while true {
      do {
        return try exchange()
      } catch let failure as Failure where failure.code == .appUnavailable && Date.now < deadline {
        Thread.sleep(forTimeInterval: 0.2)
      }
    }
  }

  /// The CLI lives at SafariPilot.app/Contents/SharedSupport/safaripilot, reached through a PATH symlink.
  private static func launch() throws {
    let app = Bundle.main.executableURL!.resolvingSymlinksInPath().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    guard app.pathExtension == "app" else { throw Failure(.appUnavailable, "SafariPilot.app is not running, and this CLI at \(Bundle.main.executablePath ?? "?") is not inside it to launch it") }

    let open = Process()
    open.executableURL = URL(filePath: "/usr/bin/open")
    open.arguments = ["-g", app.path]
    try open.run()
    open.waitUntilExit()
    guard open.terminationStatus == 0 else { throw Failure(.appUnavailable, "could not launch \(app.path): open exited \(open.terminationStatus)") }
  }
}
