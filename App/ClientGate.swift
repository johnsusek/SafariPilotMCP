import AppKit
import Observation
import SwiftUI
import UserNotifications

/// Approves MCP clients the way iMCP does: a dialog per new client, credentials that skip it once trusted,
/// and a session key per approved MCP process that every command must carry until the app quits or the session is revoked.
@Observable @MainActor
final class ClientGate {
  struct Session: Identifiable {
    let id: String
    let name: String
    let recordId: String?
    let since: Date
  }

  /// What the dialog knows about a client beyond the name it reported.
  struct Request {
    let name: String
    let record: ClientRecord?
    let unrecognizedCredential: Bool

    var identityNote: String {
      if let record { return "It uses the credential SafariPilot created for \"\(record.name)\" on \(record.issuedAt.formatted(date: .abbreviated, time: .omitted))." }
      if unrecognizedCredential { return "It presented a credential SafariPilot didn't create or has removed." }
      return "It presented no credential, so any app could have sent this name."
    }
  }

  typealias Waiter = CheckedContinuation<Bool, Never>

  private(set) var sessions: [Session] = []
  private(set) var storeError: String?
  private let store: ClientStore?
  private var queue = ApprovalQueue<Request, Waiter>()
  private let windows = GateWindows()

  init() {
    do {
      store = try ClientStore(storage: KeychainClientRecordStorage())
    } catch {
      store = nil
      storeError = "\(error)"
    }
  }

  var trustedClients: [ClientRecord] { store?.records.filter(\.trusted).sorted { $0.name < $1.name } ?? [] }

  func knows(credential: String?) -> Bool { store?.record(for: credential) != nil }

  /// Answers a hello once the person decides, the request expires, or the queue refuses it.
  func approve(_ hello: HelloRequest) async -> HelloReply {
    let name = ClientName.sanitized(hello.clientName)
    let record = store?.record(for: hello.credential)

    if let record, record.trusted {
      notify("\(name) connected")
      return HelloReply(session: open(name: name, recordId: record.id), text: "approved: trusted client \(record.name)")
    }

    let request = Request(name: name, record: record, unrecognizedCredential: hello.credential != nil && record == nil)
    let key = record.map { "credential:\($0.id)" } ?? "connection:\(UUID().uuidString)"
    var refusal: String?

    let approved = await withCheckedContinuation { (waiter: Waiter) in
      switch queue.enqueue(key: key, cooldownKey: record?.id, request: request, waiter: waiter, now: .now) {
      case let .show(deadline):
        present(key: key, request: request)
        expire(at: deadline)
      case let .queued(deadline): expire(at: deadline)
      case .joined: break
      case let .rejected(reason):
        refusal = reason
        waiter.resume(returning: false)
      }
    }

    if let refusal { return HelloReply(session: nil, text: "SafariPilot refused \(name): \(refusal)") }
    guard approved else { return HelloReply(session: nil, text: "The user did not allow \(name) to use Safari through SafariPilot.") }

    return HelloReply(session: open(name: name, recordId: store?.record(for: hello.credential)?.id), text: "approved")
  }

  /// Why a command may not run, or nil when it may. Debug builds let session-less requests through for the dev CLI and smoke tests.
  func refusal(for request: CLIRequest) -> String? {
    #if DEBUG
      if request.session == nil { return nil }
    #else
      if request.command.isDevTool { return "\(request.command) is a dev tool available only in Debug builds" }
      if request.command == .status { return nil }
    #endif

    guard let key = request.session, sessions.contains(where: { $0.id == key }) else { return "not approved: this client's SafariPilot session is missing or was revoked" }

    return nil
  }

  func revoke(_ session: Session) { sessions.removeAll { $0.id == session.id } }

  /// Removes a trusted client; its credential stops working and its sessions end.
  func remove(_ record: ClientRecord) {
    do {
      try store?.remove(id: record.id)
      sessions.removeAll { $0.recordId == record.id }
    } catch {
      storeError = "\(error)"
    }
  }

  /// A credential to write into a client's MCP settings: the one already there when SafariPilot knows it, else a new untrusted one.
  func credentialForSettings(name: String, existing: String?) throws -> String {
    guard let store else { throw Failure(description: "client credentials are unavailable: \(storeError ?? "keychain not loaded")") }

    if let existing, store.record(for: existing) != nil { return existing }

    return try store.issue(name: name, trusted: false)
  }

  private func open(name: String, recordId: String?) -> String {
    let key = String(decoding: Wire.newToken(), as: UTF8.self)
    sessions.append(Session(id: key, name: name, recordId: recordId, since: .now))
    return key
  }

  private func present(key: String, request: Request) {
    windows.show(key: key, onClose: { [weak self] in self?.finish(key: key, approved: false, alwaysTrust: false) }) {
      ApprovalView(request: request) { [weak self] approved, alwaysTrust in self?.finish(key: key, approved: approved, alwaysTrust: alwaysTrust) }
    }
  }

  private func expire(at deadline: ContinuousClock.Instant) {
    Task { [weak self] in
      try? await Task.sleep(until: deadline)
      self?.settle(self?.queue.expire(now: .now), approved: false)
    }
  }

  private func finish(key: String, approved: Bool, alwaysTrust: Bool) {
    let resolution = queue.resolve(key: key, approved: approved, now: .now)

    if approved, alwaysTrust, let request = resolution.removed.first?.request { trust(request) }

    settle(resolution, approved: approved)
  }

  private func settle(_ resolution: ApprovalQueue<Request, Waiter>.Resolution?, approved: Bool) {
    guard let resolution else { return }

    for entry in resolution.removed {
      windows.close(key: entry.key)

      for waiter in entry.waiters { waiter.resume(returning: approved) }
    }

    for entry in resolution.promoted { present(key: entry.key, request: entry.request) }
  }

  /// Trusts the credential the client presented, or issues a trusted one and shows it once for the client's settings.
  private func trust(_ request: Request) {
    guard let store else { return }

    do {
      if let record = request.record {
        try store.trust(id: record.id)
      } else {
        let credential = try store.issue(name: request.name, trusted: true)
        windows.show(key: "credential:\(credential)", onClose: {}) {
          CredentialView(name: request.name, credential: credential) { [weak self] in self?.windows.close(key: "credential:\(credential)") }
        }
      }

      Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) }
    } catch {
      storeError = "\(error)"
    }
  }

  private func notify(_ title: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }
}

/// Standalone dialog windows keyed by request; closing one with the title bar button runs its close handler.
@MainActor
private final class GateWindows: NSObject, NSWindowDelegate {
  private var windows: [String: NSWindow] = [:]
  private var onClose: [String: () -> Void] = [:]

  func show<Content: View>(key: String, onClose: @escaping () -> Void, @ViewBuilder content: () -> Content) {
    let window = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "SafariPilot"
    window.contentView = NSHostingView(rootView: content().padding(20).frame(width: 380))
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()
    windows[key] = window
    self.onClose[key] = onClose
    NSApp.activate()
    window.makeKeyAndOrderFront(nil)
  }

  /// Closes without running the close handler, since the caller already settled the request.
  func close(key: String) {
    onClose[key] = nil
    windows.removeValue(forKey: key)?.close()
  }

  func windowWillClose(_ notification: Notification) {
    guard let key = windows.first(where: { $0.value === notification.object as? NSWindow })?.key else { return }

    windows[key] = nil
    onClose.removeValue(forKey: key)?()
  }
}

private struct ApprovalView: View {
  let request: ClientGate.Request
  let decide: (_ approved: Bool, _ alwaysTrust: Bool) -> Void
  @State private var alwaysTrust = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 48, height: 48)
      Text("Allow \u{201C}\(request.name)\u{201D} to use Safari?").font(.headline)
      Text(request.identityNote).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      Toggle("Always trust this client", isOn: $alwaysTrust)
      HStack {
        Spacer()
        Button("Deny") { decide(false, false) }.keyboardShortcut(.cancelAction)
        Button("Allow") { decide(true, alwaysTrust) }.keyboardShortcut(.defaultAction)
      }
    }
  }
}

private struct CredentialView: View {
  let name: String
  let credential: String
  let done: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Add a Credential to \u{201C}\(name)\u{201D}").font(.headline)
      Text("To connect without asking, add this environment variable to SafariPilot in the client's MCP settings. SafariPilot keeps no copy.").font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      Text("\(HelloRequest.credentialVariable)=\(credential)").font(.caption.monospaced()).textSelection(.enabled)
      HStack {
        Spacer()
        Button("Copy Value") {
          let pasteboard = NSPasteboard.general
          pasteboard.prepareForNewContents(with: .currentHostOnly)
          pasteboard.setString(credential, forType: .string)
        }
        Button("Done", action: done).keyboardShortcut(.defaultAction)
      }
    }
  }
}
