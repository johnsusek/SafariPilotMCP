import SwiftUI

struct ClientsView: View {
  let model: AppModel
  @State private var confirmingRemoveAll = false

  var body: some View {
    Form {
      Section("Connect a Client") {
        ForEach(ClientSetup.Client.allCases) { client in
          LabeledContent {
            if model.configured.contains(client) { Text("Already set up").foregroundStyle(.secondary) } else { Button(client == .claudeCode ? "Copy" : "Set Up…") { model.setUp(client) } }
          } label: {
            Text(client.rawValue)
            Text(detail(client))
          }
        }
        LabeledContent {
          Button("Copy") { model.copyConfigJSON() }
        } label: {
          Text("Other Clients")
          Text("Copies an mcpServers JSON entry with a new credential.")
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

  private func detail(_ client: ClientSetup.Client) -> String {
    if let json = client.json { return "Adds SafariPilot to \((json.url.path as NSString).abbreviatingWithTildeInPath)." }

    if client == .claudeCode { return "Copies a claude mcp add command with a new credential." }

    return "Runs codex mcp add, for ChatGPT's Mac app and Codex CLI."
  }
}
