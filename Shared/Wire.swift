import Foundation

struct Failure: Error, CustomStringConvertible {
  let description: String
}

/// Loopback TCP, one newline-terminated JSON request and one reply per connection.
enum Wire {
  static let port: UInt16 = 47821

  /// Blocking exchange; callers on an actor wrap it in a detached task.
  static func exchange(_ request: Data, timeoutSeconds: Int = 120) throws -> Data {
    let descriptor = socket(AF_INET, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw Failure(description: "socket() failed: errno \(errno)") }
    defer { close(descriptor) }

    var timeout = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
    setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var noSigpipe: Int32 = 1
    setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))

    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard connected == 0 else { throw Failure(description: "SafariPilot.app is not listening on 127.0.0.1:\(port) (errno \(errno))") }

    let payload = request + Data([0x0A])
    let written = payload.withUnsafeBytes { write(descriptor, $0.baseAddress, payload.count) }
    guard written == payload.count else { throw Failure(description: "write failed: errno \(errno)") }

    var reply = Data()
    var buffer = [UInt8](repeating: 0, count: 65536)

    while true {
      let count = read(descriptor, &buffer, buffer.count)
      guard count > 0 else { throw Failure(description: count == 0 ? "connection closed before reply" : "read failed: errno \(errno)") }
      reply.append(buffer, count: count)

      if buffer[0 ..< count].contains(0x0A) { break }
    }

    return reply.prefix { $0 != 0x0A }
  }
}
