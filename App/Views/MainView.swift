import AppKit
import SwiftUI

enum Pane: String, CaseIterable, Identifiable {
  case general, clients, activity

  var id: Self { self }

  var title: String { rawValue.capitalized }

  var symbol: String {
    switch self {
    case .general: "gearshape"
    case .clients: "point.3.connected.trianglepath.dotted"
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
        case .activity: ActivityView(model: model)
        }
      }
      .navigationTitle(pane.title)
    }
    .frame(minWidth: 640, minHeight: 420)
    .showsDockIcon()
  }
}

@MainActor private var openWindows = 0

extension View {
  /// A Dock icon and menu bar only while a window is open; otherwise the app lives in the menu bar alone.
  func showsDockIcon() -> some View {
    onAppear {
      openWindows += 1
      NSApp.setActivationPolicy(.regular)
    }
    .onDisappear {
      openWindows -= 1
      if openWindows == 0 { NSApp.setActivationPolicy(.accessory) }
    }
  }
}
