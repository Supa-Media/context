import SwiftUI
import WidgetKit

private let appGroup = Bundle.main.object(forInfoDictionaryKey: "ContextAppGroup") as? String

private struct QuickCaptureEntry: TimelineEntry {
  let date: Date
  let upcomingTitle: String?
  let upcomingAt: Date?
}

private struct QuickCaptureProvider: TimelineProvider {
  func placeholder(in context: Context) -> QuickCaptureEntry {
    QuickCaptureEntry(date: Date(), upcomingTitle: nil, upcomingAt: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (QuickCaptureEntry) -> Void) {
    completion(readEntry())
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<QuickCaptureEntry>) -> Void) {
    let entry = readEntry()
    let refresh = entry.upcomingAt.map { max(Date().addingTimeInterval(60), $0.addingTimeInterval(60)) }
      ?? Date().addingTimeInterval(15 * 60)
    completion(Timeline(entries: [entry], policy: .after(refresh)))
  }

  private func readEntry() -> QuickCaptureEntry {
    guard let appGroup,
      let data = UserDefaults(suiteName: appGroup)?.data(forKey: "context.widget.snapshot"),
      let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return QuickCaptureEntry(date: Date(), upcomingTitle: nil, upcomingAt: nil) }
    let upcomingAt = (json["upcomingAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1_000) }
    let upcomingTitle = upcomingAt.map { $0 > Date() ? json["upcomingTitle"] as? String : nil } ?? nil
    return QuickCaptureEntry(date: Date(), upcomingTitle: upcomingTitle, upcomingAt: upcomingAt)
  }
}

struct ContextQuickCaptureWidget: Widget {
  let kind = "ContextQuickCaptureWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: QuickCaptureProvider()) { entry in
      QuickCaptureView(entry: entry)
    }
    .configurationDisplayName("Context Quick Capture")
    .description("Start a note or record a meeting.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

private struct QuickCaptureView: View {
  let entry: QuickCaptureEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let title = entry.upcomingTitle, let at = entry.upcomingAt {
        Text("Up next").font(.caption.bold()).foregroundStyle(.secondary)
        Text(title).font(.headline).lineLimit(2)
        Text(at, style: .relative).font(.caption)
        Link(destination: URL(string: "context://meetings?quickAction=meeting")!) {
          Label("Prepare recording", systemImage: "mic.fill")
        }
      } else {
        Text("Context").font(.headline)
        Link(destination: URL(string: "context://console?quickAction=note")!) {
          Label("New note", systemImage: "square.and.pencil")
        }
        Link(destination: URL(string: "context://meetings?quickAction=meeting")!) {
          Label("Record meeting", systemImage: "mic.fill")
        }
      }
    }
    .padding()
    .contextWidgetBackground()
  }
}

private extension View {
  @ViewBuilder
  func contextWidgetBackground() -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      containerBackground(.background, for: .widget)
    } else {
      background(Color(.systemBackground))
    }
  }
}
