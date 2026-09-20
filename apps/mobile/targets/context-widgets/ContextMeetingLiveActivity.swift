import ActivityKit
import SwiftUI
import WidgetKit

// v1 controls are authenticated deep links: tapping opens Context (and may
// require unlock) before the app verifies the meeting id and acts; the widget
// extension never controls the recorder cross-process.

@available(iOSApplicationExtension 16.1, *)
struct ContextMeetingLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: ContextMeetingActivityAttributes.self) { context in
      MeetingLockScreenView(context: context)
        .activityBackgroundTint(Color.black.opacity(0.92))
        .activitySystemActionForegroundColor(.white)
        .widgetURL(meetingURL(context.attributes.meetingId))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          RecordingGlyph(phase: context.state.phase)
        }
        DynamicIslandExpandedRegion(.trailing) {
          MeetingTimer(state: context.state, compact: true)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.state.title)
            .font(.headline)
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(spacing: 18) {
            Link(destination: actionURL(context.attributes.meetingId, action: context.state.phase == "paused" ? "resume" : "pause", controlToken: context.state.controlToken)) {
              Label(context.state.phase == "paused" ? "Resume" : "Pause", systemImage: context.state.phase == "paused" ? "play.fill" : "pause.fill")
            }
            Link(destination: meetingURL(context.attributes.meetingId)) {
              Label("Open note", systemImage: "note.text")
            }
            Link(destination: actionURL(context.attributes.meetingId, action: "end", controlToken: context.state.controlToken)) {
              Label("End", systemImage: "stop.fill")
            }
          }
          .font(.caption.bold())
        }
      } compactLeading: {
        RecordingGlyph(phase: context.state.phase)
      } compactTrailing: {
        MeetingTimer(state: context.state, compact: true)
      } minimal: {
        RecordingGlyph(phase: context.state.phase)
      }
      .widgetURL(meetingURL(context.attributes.meetingId))
      .keylineTint(.red)
    }
  }
}

@available(iOSApplicationExtension 16.1, *)
private struct MeetingLockScreenView: View {
  let context: ActivityViewContext<ContextMeetingActivityAttributes>

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        RecordingGlyph(phase: context.state.phase)
        Text(context.state.phase == "paused" ? "Recording paused" : "Recording")
          .font(.subheadline.bold())
        Spacer()
        MeetingTimer(state: context.state, compact: false)
      }
      Text(context.state.title)
        .font(.headline)
        .lineLimit(1)
      HStack(spacing: 14) {
        Link(destination: actionURL(context.attributes.meetingId, action: context.state.phase == "paused" ? "resume" : "pause", controlToken: context.state.controlToken)) {
          Label(context.state.phase == "paused" ? "Resume" : "Pause", systemImage: context.state.phase == "paused" ? "play.fill" : "pause.fill")
        }
        Link(destination: meetingURL(context.attributes.meetingId)) {
          Label("Open note", systemImage: "note.text")
        }
        Spacer()
        Link(destination: actionURL(context.attributes.meetingId, action: "end", controlToken: context.state.controlToken)) {
          Label("End", systemImage: "stop.fill")
            .foregroundStyle(.red)
        }
      }
      .font(.subheadline.bold())
    }
    .padding(16)
    .foregroundStyle(.white)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Context meeting recording")
  }
}

@available(iOSApplicationExtension 16.1, *)
private struct RecordingGlyph: View {
  let phase: String

  var body: some View {
    Image(systemName: phase == "paused" ? "pause.circle.fill" : "mic.circle.fill")
      .foregroundStyle(phase == "paused" ? .orange : .red)
      .accessibilityLabel(phase == "paused" ? "Paused" : "Microphone recording")
  }
}

@available(iOSApplicationExtension 16.1, *)
private struct MeetingTimer: View {
  let state: ContextMeetingActivityAttributes.ContentState
  let compact: Bool

  var body: some View {
    Group {
      if state.phase == "recording", let since = state.recordingSince {
        Text(since.addingTimeInterval(-state.recordedMilliseconds / 1_000), style: .timer)
      } else {
        Text(formatDuration(state.recordedMilliseconds))
      }
    }
    .font(compact ? .caption.monospacedDigit() : .headline.monospacedDigit())
    .accessibilityLabel("Elapsed recording time")
  }
}

private func meetingURL(_ meetingId: String) -> URL {
  URL(string: "context://meetings/\(meetingId)")!
}

private func actionURL(_ meetingId: String, action: String, controlToken: String) -> URL {
  var components = URLComponents(string: "context://meetings/\(meetingId)")!
  components.queryItems = [
    URLQueryItem(name: "activityAction", value: action),
    URLQueryItem(name: "controlToken", value: controlToken),
  ]
  return components.url!
}

private func formatDuration(_ milliseconds: Double) -> String {
  let total = max(0, Int(milliseconds / 1_000))
  return String(format: "%d:%02d", total / 60, total % 60)
}
