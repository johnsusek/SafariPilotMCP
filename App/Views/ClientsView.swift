import SwiftUI

struct ClientsView: View {
  let model: AppModel
  @State private var confirmingRemoveAll = false

  var body: some View {
    Form {
      Section("Connect a Client") {
        LabeledContent {
          Button(model.desktopAdded ? "Set Up Again…" : "Set Up…") { model.configureClaudeDesktop() }
        } label: {
          Text("Claude Desktop")
          Text("Adds SafariPilot to Claude Desktop's MCP servers.")
        }
        LabeledContent {
          Button("Copy") { model.copyClaudeCodeCommand() }
        } label: {
          Text("Claude Code")
          Text("Copies a claude mcp add command with a new credential.")
        }
      }

      Section {
        if let error = model.gate.storeError { Text(error).foregroundStyle(.red).textSelection(.enabled) }

        if model.gate.trustedClients.isEmpty { Text("None").foregroundStyle(.secondary) }

        ForEach(model.gate.trustedClients) { record in
          LabeledContent {
            Button("Remove") { model.gate.remove(record) }
          } label: {
            Text(record.name)
            Text("Trusted since \(record.issuedAt.formatted(date: .abbreviated, time: .omitted))")
          }
        }
      } header: {
        Text("Trusted Clients")
      } footer: {
        HStack(alignment: .top) {
          Text("Trusted clients connect without asking and post a notification. Removing one revokes its credential.").foregroundStyle(.secondary)
          Spacer()
          Button("Remove All…") { confirmingRemoveAll = true }.disabled(model.gate.trustedClients.isEmpty)
        }
      }

      Section("Connected") {
        if model.gate.sessions.isEmpty { Text("None").foregroundStyle(.secondary) }

        ForEach(model.gate.sessions) { session in
          LabeledContent {
            Button("Disconnect") { model.gate.revoke(session) }
          } label: {
            Text(session.name)
            Text("Since \(session.since.formatted(date: .omitted, time: .shortened))")
          }
        }
      }
    }
    .formStyle(.grouped)
    .confirmationDialog("Remove all trusted clients?", isPresented: $confirmingRemoveAll) {
      Button("Remove All", role: .destructive) { model.gate.removeAll() }
    } message: {
      Text("Their credentials stop working and they must be approved again.")
    }
  }
}
