import Foundation
import Network

/// Loopback listener shared by the appex relay and the CLI: one JSON line in, one JSON line out.
@MainActor
enum Server {
  static func run(model: AppModel) async {
    do {
      let parameters = NWParametersBuilder.parameters { TCP() }
        .localEndpoint(.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Wire.port)!))
        .localEndpointReuseAllowed(true)
      let listener = try NetworkListener(using: parameters)
        .onStateUpdate { _, state in
          switch state {
          case .ready: model.transport.setListening(true)
          case let .failed(error), let .waiting(error): model.transport.setListening(false, error: "\(error)")
          default: break
          }
        }

      try await listener.run { connection in
        do {
          try await serve(connection, model: model)
        } catch {
          model.record("connection", ok: false, summary: "\(error)")
        }
      }
    } catch {
      model.transport.setListening(false, error: "\(error)")
    }
  }

  private static func serve(_ connection: NetworkConnection<TCP>, model: AppModel) async throws {
    var buffer = Data()

    while true {
      let (content, metadata) = try await connection.receive(atMost: 1 << 20)
      buffer.append(content)

      if content.contains(0x0A) || metadata.endOfStream { break }
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
