import ServiceManagement
import SwiftUI

struct GeneralView: View {
  let model: AppModel

  var body: some View {
    Form {
      Section {
        Toggle(isOn: Binding(get: { model.loginItem == .enabled }, set: { model.setLaunchAtLogin($0) })) {
          Text("Launch at Login")
          Text("Opens SafariPilot when you log in, so Claude can reach Safari.")
        }

        if model.loginItem == .requiresApproval {
          LabeledContent {
            Button("Open Login Items…") { SMAppService.openSystemSettingsLoginItems() }
          } label: {
            Text("Needs Approval")
            Text("Allow SafariPilot in System Settings.")
          }
        }
      }

      Section("Status") {
        LabeledContent {
          if !model.axTrusted { Button("Grant…") { model.requestAccessibility() } }
        } label: {
          Text("Accessibility")
          Text(model.axTrusted ? "Granted" : "Not granted")
        }
        LabeledContent {
          Button("Safari Settings…") { Task { await model.openExtensionSettings() } }
        } label: {
          Text("Safari Extension")
          Text(model.extensionState.capitalized)
        }
        LabeledContent {
          Text(model.build ?? "None").textSelection(.enabled)
        } label: {
          Text("Build")

          if let mismatch = model.buildMismatch {
            Text(mismatch.description).foregroundStyle(.red).textSelection(.enabled)
          } else {
            Text(model.extensionBuild == nil ? "Extension not seen yet" : "Extension matches")
          }
        }
        TimelineView(.periodic(from: .now, by: 1)) { context in
          LabeledContent {
            Text(model.transport.listening ? "127.0.0.1:\(String(Wire.port))" : "Down \(model.transport.listenError ?? "")").textSelection(.enabled)
          } label: {
            Text("Bridge")
            Text(backgroundState(now: context.date))
          }
        }
      }
    }
    .formStyle(.grouped)
  }

  private func backgroundState(now: Date) -> String {
    let transport = model.transport
    let seen = transport.lastSeen.map { "seen \(Int(now.timeIntervalSince($0)))s ago" } ?? "never seen"
    return transport.openPollCount > 0 ? "Extension reachable, \(seen)" : "Extension not reachable, \(seen)"
  }
}
