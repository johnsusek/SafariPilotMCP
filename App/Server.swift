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

  private static func serve(_ connection: NetworkConnection<TCP>, token: Data, model: AppModel) async throws {
    var buffer = Data()
    var authenticated = false

    while true {
      let (content, metadata) = try await connection.receive(atMost: 1 << 20)
      buffer.append(content)

      if !authenticated, let result = Wire.authenticate(buffer, token: token) {
        switch result {
        case let .success(rest):
          buffer = rest
          authenticated = true
        case let .failure(failure):
          model.record("connection", ok: false, summary: "rejected: \(failure)")
          try await connection.send(Wire.rejection + Data("\(failure)\n".utf8), endOfStream: true)
          return
        }
      }

      if metadata.endOfStream || (authenticated && buffer.contains(0x0A)) { break }
    }

    guard authenticated else {
      model.record("connection", ok: false, summary: "rejected: closed before token line")
      return
    }

    let message = try JSONDecoder().decode(JSONValue.self, from: buffer.prefix { $0 != 0x0A })
    let reply: Data = if message["kind"]?.string == "cli" {
      try await JSONEncoder().encode(model.runCLI(message.decode(CLIRequest.self)))
    } else {
      try await JSONEncoder().encode(model.transport.handle(message))
    }

    try await connection.send(reply + Data([0x0A]), endOfStream: true)
  }
}
