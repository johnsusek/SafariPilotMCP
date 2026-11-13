import Foundation
import Security

struct Failure: Error, CustomStringConvertible {
  let description: String
}

/// Loopback TCP, one connection per exchange: the client sends a token line then one JSON line; the app replies with one JSON line,
/// or a `rejected:` line when the token is wrong. The app publishes a fresh token per launch where only its own clients can read it.
enum Wire {
  static let port: UInt16 = 47821
  static let appGroup = "WX2UGCD2SK.net.johnsolo.SafariPilot"
  static let rejection = Data("rejected: ".utf8)
  static let maxTokenLine = 128

  /// The sandboxed appex can read only the group container copy; the CLI only the Application Support copy, since macOS 27 denies
  /// group container access to anything attributed to another team (Terminal, the MCP host).
  static var groupTokenURL: URL {
    get throws {
      guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { throw Failure(description: "app group \(appGroup) is not available to this process") }
      return container.appending(path: "token")
    }
  }

  static var userTokenURL: URL { URL.applicationSupportDirectory.appending(path: "SafariPilot/token") }

  static func newToken() -> Data {
    var bytes = [UInt8](repeating: 0, count: 32)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
    return Data(bytes.map { String(format: "%02x", $0) }.joined().utf8)
  }

  static func publish(_ token: Data) throws {
    for url in try [groupTokenURL, userTokenURL] {
      let directory = url.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
      try token.write(to: url, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
  }

  static func readToken() throws -> Data {
    let url = try Bundle.main.bundlePath.hasSuffix(".appex") ? groupTokenURL : userTokenURL

    do {
      return try Data(contentsOf: url)
    } catch {
      throw Failure(description: "cannot read the SafariPilot token at \(url.path) (is SafariPilot.app running?): \(error.localizedDescription)")
    }
  }

  static func tokensMatch(_ received: Data, _ expected: Data) -> Bool {
    guard received.count == expected.count else { return false }

    return zip(received, expected).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
  }

  /// Checks the token line at the head of `buffer`. Nil means the line is not complete yet; success carries the bytes after it.
  static func authenticate(_ buffer: Data, token: Data) -> Result<Data, Failure>? {
    guard let newline = buffer.firstIndex(of: 0x0A) else {
      return buffer.count > maxTokenLine ? .failure(Failure(description: "no token line")) : nil
    }

    guard tokensMatch(buffer[buffer.startIndex ..< newline], token) else { return .failure(Failure(description: "token mismatch")) }

    return .success(Data(buffer[(newline + 1)...]))
  }

  /// The first line break at or after offset, found with memchr: a generic byte scan of a multi-megabyte file_upload line took most of the upload's time.
  static func newline(in data: Data, from offset: Int = 0) -> Data.Index? {
    data.withUnsafeBytes { bytes in
      guard offset < bytes.count, let base = bytes.baseAddress, let found = memchr(base + offset, 0x0A, bytes.count - offset) else { return nil }

      return data.startIndex + base.distance(to: UnsafeRawPointer(found))
    }
  }

  /// Blocking exchange; callers on an actor wrap it in a detached task.
  static func exchange(_ request: Data, timeoutSeconds: Int = 120) throws -> Data {
    let token = try readToken()
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

    let payload = token + Data([0x0A]) + request + Data([0x0A])
    let written = payload.withUnsafeBytes { write(descriptor, $0.baseAddress, payload.count) }
    guard written == payload.count else { throw Failure(description: "write failed: errno \(errno)") }

    var reply = Data()
    var buffer = [UInt8](repeating: 0, count: 65536)

    while true {
      let count = read(descriptor, &buffer, buffer.count)
      if count < 0, errno == EAGAIN { throw Failure(description: "SafariPilot.app sent no reply within \(timeoutSeconds) s; it is still busy with this or an earlier command") }

      guard count > 0 else { throw Failure(description: count == 0 ? "connection closed before reply" : "read failed: errno \(errno)") }
      reply.append(buffer, count: count)

      if buffer[0 ..< count].contains(0x0A) { break }
    }

    let line = reply[..<(newline(in: reply) ?? reply.endIndex)]

    if line.starts(with: rejection) {
      throw Failure(description: "SafariPilot.app rejected the connection: \(String(decoding: line.dropFirst(rejection.count), as: UTF8.self))")
    }

    return line
  }
}
