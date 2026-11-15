import SwiftUI

struct ToolsView: View {
  private let readOnly: Set = ["tabs_list", "read_page", "find", "get_page_text", "screenshot", "wait"]
  @AppStorage(PageFetchRequest.writesKey) private var pageFetchWrites = false

  var body: some View {
    Form {
      Section {
        ForEach(Tools.definitions, id: \.name) { tool in
          VStack(alignment: .leading, spacing: 3) {
            HStack {
              Text(tool.name)

              if readOnly.contains(tool.name) || (tool.name == "page_fetch" && !pageFetchWrites) { Text("Read-only").font(.caption).foregroundStyle(.secondary).padding(.horizontal, 6).padding(.vertical, 1).background(.quaternary, in: .capsule) }
            }
            Text(tool.description).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
    .formStyle(.grouped)
  }
}
