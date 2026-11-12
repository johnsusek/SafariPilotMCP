import SwiftUI

struct StatusView: View {
  let model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      Form {
        LabeledContent("Accessibility") {
          HStack {
            Text(model.axTrusted ? "Granted" : "Not granted")
            if !model.axTrusted { Button("Grant…") { model.requestAccessibility() } }
          }
        }
        LabeledContent("Extension") {
          HStack {
            Text(model.extensionState.capitalized)
            Button("Safari Settings…") { Task { await model.openExtensionSettings() } }
          }
        }
        LabeledContent("Listener") {
          Text(model.transport.listening ? "127.0.0.1:\(String(Wire.port))" : "Down \(model.transport.listenError ?? "")")
            .textSelection(.enabled)
        }
        TimelineView(.periodic(from: .now, by: 1)) { context in
          LabeledContent("Background") { Text(backgroundState(now: context.date)) }
        }
        LabeledContent("Claude Desktop") {
          HStack {
            Text(model.desktopAdded ? "Added" : "Not added")
            if !model.desktopAdded { Button("Add") { model.addToClaudeDesktop() } }
          }
        }
        LabeledContent("Claude Code") {
          Button("Copy Command") { model.copyClaudeCodeCommand() }
            .help("Copies a claude mcp add command with a new credential")
        }
        Section("Clients") {
          if let error = model.gate.storeError { Text(error).foregroundStyle(.red).textSelection(.enabled) }

          if model.gate.trustedClients.isEmpty && model.gate.sessions.isEmpty { Text("None").foregroundStyle(.secondary) }

          ForEach(model.gate.trustedClients) { record in
            LabeledContent(record.name) {
              HStack {
                Text("Trusted since \(record.issuedAt.formatted(date: .abbreviated, time: .omitted))").foregroundStyle(.secondary)
                Button("Remove") { model.gate.remove(record) }
              }
            }
          }

          ForEach(model.gate.sessions) { session in
            LabeledContent(session.name) {
              HStack {
                Text("Connected \(session.since.formatted(date: .omitted, time: .shortened))").foregroundStyle(.secondary)
                Button("Disconnect") { model.gate.revoke(session) }
              }
            }
          }
        }
      }
      .formStyle(.grouped)
      .fixedSize(horizontal: false, vertical: true)

      Table(model.log.reversed()) {
        TableColumn("Time") { Text($0.at.formatted(date: .omitted, time: .standard)) }
          .width(min: 70, ideal: 80, max: 100)
        TableColumn("Command", value: \.command)
          .width(min: 100, ideal: 160)
        TableColumn("Result") { entry in
          Text(entry.summary)
            .foregroundStyle(entry.ok ? Color.primary : Color.red)
            .textSelection(.enabled)
        }
      }
    }
    .frame(minWidth: 520, minHeight: 360)
    .alert(model.setupAlert?.title ?? "", isPresented: Binding(get: { model.setupAlert != nil }, set: { if !$0 { model.setupAlert = nil } })) {
      Button("OK") {}
    } message: {
      Text(model.setupAlert?.message ?? "")
    }
  }

  private func backgroundState(now: Date) -> String {
    let transport = model.transport
    let seen = transport.lastSeen.map { "seen \(Int(now.timeIntervalSince($0)))s ago" } ?? "never seen"
    return transport.openPollCount > 0 ? "Reachable, \(seen)" : "Not reachable, \(seen)"
  }
}
