import ActivityKit
import Foundation

@available(iOSApplicationExtension 16.1, *)
struct ContextMeetingActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    let title: String
    let phase: String
    let recordedMilliseconds: Double
    let recordingSince: Date?
  }

  let meetingId: String
}
