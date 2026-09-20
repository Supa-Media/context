import ActivityKit
import ExpoModulesCore
import Foundation
import WidgetKit

public final class ContextActivityKitModule: Module {
  private let coordinator = ContextActivityCoordinator()
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
      let generation = try Self.number(payload, "generation")
      let url = Self.stringOrNil(payload["url"])
      await self.coordinator.upsert(
        meetingId: meetingId, state: state, generation: generation,
        snapshot: payload, url: url
      )
    }

    AsyncFunction("end") { (meetingId: String, generation: Double) async in
      guard #available(iOS 16.1, *) else { return }
      await self.coordinator.end(meetingId: meetingId, generation: generation)
    }

    AsyncFunction("reconcile") { (activeMeetingId: String?, generation: Double) async in
      guard #available(iOS 16.1, *) else { return }
      await self.coordinator.reconcile(activeMeetingId: activeMeetingId, generation: generation)
    }
  }

  @available(iOS 16.1, *)
  private static func contentState(_ payload: [String: Any]) throws -> ContextMeetingActivityAttributes.ContentState {
    let sinceMilliseconds = payload["recordingSince"] as? Double
    return ContextMeetingActivityAttributes.ContentState(
      title: try string(payload, "title"),
      controlToken: try string(payload, "controlToken"),
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

  private static func number(_ payload: [String: Any], _ key: String) throws -> Double {
    guard let value = payload[key] as? Double, value.isFinite, value >= 0 else {
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

  fileprivate static func writeWidgetSnapshot(payload: [String: Any], url: String?) {
    guard let appGroup, let defaults = UserDefaults(suiteName: appGroup) else { return }
    var snapshot = payload
    snapshot["url"] = url
    snapshot["updatedAt"] = Date().timeIntervalSince1970 * 1_000
    if let data = try? JSONSerialization.data(withJSONObject: snapshot) {
      defaults.set(data, forKey: "context.widget.snapshot")
      WidgetCenter.shared.reloadTimelines(ofKind: "ContextQuickCaptureWidget")
    }
  }

  fileprivate static func clearWidgetRecording(meetingId: String) {
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

private actor ContextActivityCoordinator {
  private var latestGeneration: Double = -1
  private var tail: Task<Void, Never>?

  private func isCurrent(_ generation: Double) -> Bool {
    generation == latestGeneration
  }

  @available(iOS 16.1, *)
  func upsert(
    meetingId: String,
    state: ContextMeetingActivityAttributes.ContentState,
    generation: Double,
    snapshot: [String: Any],
    url: String?
  ) async {
    guard generation > latestGeneration else { return }
    latestGeneration = generation
    let preceding = tail
    let operation = Task { [self] in
      await preceding?.value
      guard isCurrent(generation) else { return }
      await performUpsert(
        meetingId: meetingId, state: state, generation: generation,
        snapshot: snapshot, url: url
      )
      guard isCurrent(generation) else { return }
    }
    tail = operation
    await operation.value
    guard isCurrent(generation) else { return }
  }

  @available(iOS 16.1, *)
  private func performUpsert(
    meetingId: String,
    state: ContextMeetingActivityAttributes.ContentState,
    generation: Double,
    snapshot: [String: Any],
    url: String?
  ) async {
    let matching = Activity<ContextMeetingActivityAttributes>.activities.filter {
      $0.attributes.meetingId == meetingId
    }
    if let keeper = matching.first {
      await keeper.update(using: state)
      guard isCurrent(generation) else { return }
      for duplicate in matching.dropFirst() {
        await duplicate.end(dismissalPolicy: .immediate)
        guard isCurrent(generation) else { return }
      }
      ContextActivityKitModule.writeWidgetSnapshot(payload: snapshot, url: url)
      return
    }
    do {
      _ = try Activity<ContextMeetingActivityAttributes>.request(
        attributes: ContextMeetingActivityAttributes(meetingId: meetingId),
        contentState: state,
        pushType: nil
      )
      guard isCurrent(generation) else { return }
      ContextActivityKitModule.writeWidgetSnapshot(payload: snapshot, url: url)
    } catch {
      // Live Activity presentation is optional and must not affect capture.
    }
  }

  @available(iOS 16.1, *)
  func end(meetingId: String, generation: Double) async {
    guard generation > latestGeneration else { return }
    latestGeneration = generation
    let preceding = tail
    let operation = Task { [self] in
      await preceding?.value
      guard isCurrent(generation) else { return }
      await performEnd(meetingId: meetingId, generation: generation)
      guard isCurrent(generation) else { return }
    }
    tail = operation
    await operation.value
    guard isCurrent(generation) else { return }
  }

  @available(iOS 16.1, *)
  private func performEnd(meetingId: String, generation: Double) async {
    for activity in Activity<ContextMeetingActivityAttributes>.activities where
      activity.attributes.meetingId == meetingId
    {
      await activity.end(dismissalPolicy: .immediate)
      guard isCurrent(generation) else { return }
    }
    ContextActivityKitModule.clearWidgetRecording(meetingId: meetingId)
  }

  @available(iOS 16.1, *)
  func reconcile(activeMeetingId: String?, generation: Double) async {
    guard generation > latestGeneration else { return }
    latestGeneration = generation
    let preceding = tail
    let operation = Task { [self] in
      await preceding?.value
      guard isCurrent(generation) else { return }
      await performReconcile(activeMeetingId: activeMeetingId, generation: generation)
      guard isCurrent(generation) else { return }
    }
    tail = operation
    await operation.value
    guard isCurrent(generation) else { return }
  }

  @available(iOS 16.1, *)
  private func performReconcile(activeMeetingId: String?, generation: Double) async {
    for activity in Activity<ContextMeetingActivityAttributes>.activities where
      activity.attributes.meetingId != activeMeetingId
    {
      let staleMeetingId = activity.attributes.meetingId
      await activity.end(dismissalPolicy: .immediate)
      guard isCurrent(generation) else { return }
      ContextActivityKitModule.clearWidgetRecording(meetingId: staleMeetingId)
    }
  }
}
