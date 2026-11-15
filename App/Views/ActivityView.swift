import SwiftUI

struct ActivityView: View {
  let model: AppModel

  var body: some View {
    Table(model.log.reversed()) {
      TableColumn("Time") { Text($0.at.formatted(date: .omitted, time: .standard)) }
        .width(min: 70, ideal: 80, max: 100)
      TableColumn("Command", value: \.command)
        .width(min: 100, ideal: 160)
      TableColumn("Result") { entry in
        Text(entry.summary).foregroundStyle(entry.ok ? Color.primary : Color.red).textSelection(.enabled)
      }
      TableColumn("Timing") { entry in
        let line = entry.timing?.line ?? ""
        Text(line).foregroundStyle(.secondary).textSelection(.enabled).help(line)
      }
      .width(min: 120, ideal: 320)
    }
  }
}
