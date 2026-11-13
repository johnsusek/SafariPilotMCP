import Foundation
import Network

/// Loopback listener shared by the appex relay and the CLI: a token line and one JSON line in, one JSON line out.
@MainActor
enum Server {
  static func run(model: AppModel) async {
    let token = Wire.newToken()

    do {
      let parameters = NWParametersBuilder.parameters { TCP() }
        .localEndpoint(.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Wire.port)!))
        .localEndpointReuseAllowed(true)
      let listener = try NetworkListener(using: parameters)
        .onStateUpdate { _, state in
          switch state {
          case .ready: publish(token, model: model)
          case let .failed(error), let .waiting(error): model.transport.setListening(false, error: "\(error)")
          default: break
          }
        }

      try await listener.run { connection in
        do {
          try await serve(connection, token: token, model: model)
        } catch {
          model.record("connection", ok: false, summary: "\(error)")
        }
      }
    } catch {
      model.transport.setListening(false, error: "\(error)")
    }
  }

  /// Published only once this instance owns the port, so a second app instance cannot overwrite the live token.
  private static func publish(_ token: Data, model: AppModel) {
    do {
      try Wire.publish(token)
      model.transport.setListening(true)
    } catch {
      model.transport.setListening(false, error: "token not published: \(error.localizedDescription)")
      model.record("token", ok: false, summary: "not published, every client will fail: \(error.localizedDescription)")
    }
  }

  private struct Envelope: Decodable {
    let kind: String?
  }

  private static func serve(_ connection: NetworkConnection<TCP>, token: Data, model: AppModel) async throws {
    var buffer = Data()
    var authenticated = false
    var scanned = 0
    var end: Data.Index?

    while end == nil {
      let (content, metadata) = try await connection.receive(atMost: 1 << 20)
      buffer.append(content)

      if !authenticated, let result = Wire.authenticate(buffer, token: token) {
        switch result {
        case let .success(rest):
          buffer = rest
          authenticated = true
          scanned = 0
        case let .failure(failure):
          model.record("connection", ok: false, summary: "rejected: \(failure)")
          try await connection.send(Wire.rejection + Data("\(failure)\n".utf8), endOfStream: true)
          return
        }
      }

      // Only the new bytes are scanned, since an upload's line runs to tens of megabytes.
      if authenticated {
        end = Wire.newline(in: buffer, from: scanned)
        scanned = buffer.count
      }

      if metadata.endOfStream { break }
    }

    guard authenticated else {
      model.record("connection", ok: false, summary: "rejected: closed before token line")
      return
    }

    let line = buffer[..<(end ?? buffer.endIndex)]
    let decoder = JSONDecoder()
    // A CLI request is decoded straight from the line, since a detour through JSONValue costs an upload two more full copies.
    var reply: Data = switch try decoder.decode(Envelope.self, from: line).kind {
    case "cli": try await JSONEncoder().encode(model.runCLI(decoder.decode(CLIRequest.self, from: line)))
    case "hello": try await JSONEncoder().encode(model.gate.approve(decoder.decode(HelloRequest.self, from: line)))
    default: try await JSONEncoder().encode(model.transport.handle(decoder.decode(JSONValue.self, from: line)))
    }

    reply.append(0x0A)
    try await connection.send(reply, endOfStream: true)
  }
}
