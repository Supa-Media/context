import ActivityKit
import Foundation

@available(iOS 16.1, *)
public struct ContextMeetingActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public let title: String
    public let phase: String
    public let recordedMilliseconds: Double
    public let recordingSince: Date?

    public init(
      title: String,
      phase: String,
      recordedMilliseconds: Double,
      recordingSince: Date?
    ) {
      self.title = title
      self.phase = phase
      self.recordedMilliseconds = recordedMilliseconds
      self.recordingSince = recordingSince
    }
  }

  public let meetingId: String

  public init(meetingId: String) {
    self.meetingId = meetingId
  }
}
