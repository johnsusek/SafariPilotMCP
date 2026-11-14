import AppKit
import SwiftUI

enum Pane: String, CaseIterable, Identifiable {
  case general, clients, tools, activity

  var id: Self { self }

  var title: String { rawValue.capitalized }

  var symbol: String {
    switch self {
    case .general: "gearshape"
    case .clients: "point.3.connected.trianglepath.dotted"
    case .tools: "wrench.and.screwdriver"
    case .activity: "list.bullet.rectangle"
    }
  }
}

struct MainView: View {
  let model: AppModel
  @SceneStorage("pane") private var pane = Pane.general

  var body: some View {
    NavigationSplitView {
      List(Pane.allCases, selection: Binding(get: { pane }, set: { selected in if let selected { pane = selected } })) { item in
        Label(item.title, systemImage: item.symbol)
      }
      .navigationSplitViewColumnWidth(min: 170, ideal: 190)
    } detail: {
      Group {
        switch pane {
        case .general: GeneralView(model: model)
        case .clients: ClientsView(model: model)
        case .tools: ToolsView()
        case .activity: ActivityView(model: model)
        }
      }
      .navigationTitle(pane.title)
    }
    .frame(minWidth: 640, minHeight: 420)
    // A Dock icon and menu bar only while the window is open; otherwise the app lives in the menu bar alone.
    .onAppear { NSApp.setActivationPolicy(.regular) }
    .onDisappear { NSApp.setActivationPolicy(.accessory) }
    .alert(model.setupAlert?.title ?? "", isPresented: Binding(get: { model.setupAlert != nil }, set: { if !$0 { model.setupAlert = nil } })) {
      Button("OK") {}
    } message: {
      Text(model.setupAlert?.message ?? "")
    }
  }
}
