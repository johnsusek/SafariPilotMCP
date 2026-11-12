import Foundation

/// Sends one command to SafariPilot.app over the loopback wire.
enum AppClient {
  /// Blocking; the socket timeout gives the app a few seconds beyond its own deadline to answer.
  static func send(_ command: AppCommand, timeout: Double, session: String? = nil) throws -> CLIReply {
    let request = try JSONEncoder().encode(CLIRequest(command: command, timeoutSeconds: timeout, session: session))
    let reply = try Wire.exchange(request, timeoutSeconds: Int(timeout) + 5)
    return try JSONDecoder().decode(CLIReply.self, from: reply)
  }

  /// Blocking until the person answers the approval dialog; returns the session key or throws why not.
  static func hello(clientName: String, clientVersion: String, credential: String?) throws -> String {
    let request = try JSONEncoder().encode(HelloRequest(clientName: clientName, clientVersion: clientVersion, credential: credential))
    let reply = try JSONDecoder().decode(HelloReply.self, from: Wire.exchange(request, timeoutSeconds: HelloRequest.timeoutSeconds))

    guard let session = reply.session else { throw Failure(description: reply.text) }

    return session
  }
}
