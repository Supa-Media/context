import ActivityKit
import ExpoModulesCore
import Foundation
import WidgetKit

public final class ContextActivityKitModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ContextActivityKit")

    Function("isAvailable") { () -> Bool in
      guard #available(iOS 16.1, *) else { return false }
      return ActivityAuthorizationInfo().areActivitiesEnabled
    }

    AsyncFunction("upsert") { (payload: [String: Any]) async throws in
      guard #available(iOS 16.1, *) else { return }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
      let state = try Self.contentState(payload)
      let meetingId = try Self.string(payload, "meetingId")
      let url = Self.stringOrNil(payload["url"])

      if let existing = Activity<ContextMeetingActivityAttributes>.activities.first(where: {
        $0.attributes.meetingId == meetingId
      }) {
        await existing.update(using: state)
      } else {
        _ = try Activity<ContextMeetingActivityAttributes>.request(
          attributes: ContextMeetingActivityAttributes(meetingId: meetingId),
          contentState: state,
          pushType: nil
        )
      }

      Self.writeWidgetSnapshot(payload: payload, url: url)
    }

    AsyncFunction("end") { (meetingId: String) async in
      guard #available(iOS 16.1, *) else { return }
      for activity in Activity<ContextMeetingActivityAttributes>.activities where
        activity.attributes.meetingId == meetingId
      {
        await activity.end(dismissalPolicy: .immediate)
      }
      Self.clearWidgetRecording(meetingId: meetingId)
    }

    AsyncFunction("reconcile") { (activeMeetingId: String?) async in
      guard #available(iOS 16.1, *) else { return }
      for activity in Activity<ContextMeetingActivityAttributes>.activities where
        activity.attributes.meetingId != activeMeetingId
      {
        await activity.end(dismissalPolicy: .immediate)
      }
    }
  }

  @available(iOS 16.1, *)
  private static func contentState(_ payload: [String: Any]) throws -> ContextMeetingActivityAttributes.ContentState {
    let sinceMilliseconds = payload["recordingSince"] as? Double
    return ContextMeetingActivityAttributes.ContentState(
      title: try string(payload, "title"),
      phase: try string(payload, "phase"),
      recordedMilliseconds: payload["recordedMs"] as? Double ?? 0,
      recordingSince: sinceMilliseconds.map { Date(timeIntervalSince1970: $0 / 1_000) }
    )
  }

  private static func string(_ payload: [String: Any], _ key: String) throws -> String {
    guard let value = payload[key] as? String, !value.isEmpty else {
      throw Exception(name: "ERR_CONTEXT_ACTIVITY_PAYLOAD", description: "Missing \(key)")
    }
    return value
  }

  private static func stringOrNil(_ value: Any?) -> String? {
    guard let value = value as? String, !value.isEmpty else { return nil }
    return value
  }

  private static var appGroup: String? {
    Bundle.main.object(forInfoDictionaryKey: "ContextAppGroup") as? String
  }

  private static func writeWidgetSnapshot(payload: [String: Any], url: String?) {
    guard let appGroup, let defaults = UserDefaults(suiteName: appGroup) else { return }
    var snapshot = payload
    snapshot["url"] = url
    snapshot["updatedAt"] = Date().timeIntervalSince1970 * 1_000
    if let data = try? JSONSerialization.data(withJSONObject: snapshot) {
      defaults.set(data, forKey: "context.widget.snapshot")
      WidgetCenter.shared.reloadTimelines(ofKind: "ContextQuickCaptureWidget")
    }
  }

  private static func clearWidgetRecording(meetingId: String) {
    guard let appGroup, let defaults = UserDefaults(suiteName: appGroup),
      let data = defaults.data(forKey: "context.widget.snapshot"),
      var snapshot = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      snapshot["meetingId"] as? String == meetingId
    else { return }
    snapshot.removeValue(forKey: "meetingId")
    snapshot.removeValue(forKey: "phase")
    snapshot.removeValue(forKey: "recordingSince")
    snapshot.removeValue(forKey: "recordedMs")
    snapshot.removeValue(forKey: "url")
    if let next = try? JSONSerialization.data(withJSONObject: snapshot) {
      defaults.set(next, forKey: "context.widget.snapshot")
    }
    WidgetCenter.shared.reloadTimelines(ofKind: "ContextQuickCaptureWidget")
  }
}
