import SwiftUI

struct HelpView: View {
  @AppStorage("helpTopic") private var selected = Help.titles[0]

  var body: some View {
    NavigationSplitView {
      List(Help.topics, selection: Binding(get: { selected }, set: { topic in if let topic { selected = topic } })) { topic in
        Text(topic.title)
      }
      .navigationSplitViewColumnWidth(min: 170, ideal: 200)
    } detail: {
      if let topic = Help.topics.first(where: { $0.id == selected }) {
        ScrollView {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(topic.blocks.indices, id: \.self) { index in BlockView(block: topic.blocks[index]) }
          }
          .frame(maxWidth: 620, alignment: .leading)
          .padding(20)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .textSelection(.enabled)
        .navigationTitle(topic.title)
      }
    }
    .frame(minWidth: 560, minHeight: 360)
    .showsDockIcon()
  }
}

private struct BlockView: View {
  let block: Help.Block

  var body: some View {
    switch block {
    case .text(let text):
      Text(Help.inline(text))
    case .bullet(let text):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("•")
        Text(Help.inline(text))
      }
    case .callout(let kind, let text):
      GroupBox {
        Label {
          Text(Help.inline(text))
        } icon: {
          Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(kind == "CAUTION" ? .red : .orange)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    case .table(let header, let rows):
      Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
        GridRow { ForEach(header, id: \.self) { Text(Help.inline($0)).bold() } }
        Divider()
        ForEach(rows.indices, id: \.self) { index in
          GridRow { ForEach(rows[index].indices, id: \.self) { column in Text(Help.inline(rows[index][column])) } }
        }
      }
    }
  }
}
