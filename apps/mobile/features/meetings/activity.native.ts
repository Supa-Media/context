import { requireOptionalNativeModule } from "expo-modules-core";
import { activityActionFor, type MeetingActivityPayload } from "./activityCore";

interface ContextActivityKitModule {
  isAvailable(): boolean;
  upsert(payload: MeetingActivityPayload): Promise<void>;
  end(meetingId: string): Promise<void>;
  reconcile(activeMeetingId: string | null): Promise<void>;
}

const native = requireOptionalNativeModule<ContextActivityKitModule>("ContextActivityKit");

function ignoreNativeFailure(promise: Promise<void> | undefined): void {
  void promise?.catch(() => {});
}

export { activityActionFor };

export const meetingActivity = Object.freeze({
  available(): boolean {
    try { return native?.isAvailable() === true; } catch { return false; }
  },
  update(payload: MeetingActivityPayload): void {
    if (!this.available()) return;
    try { ignoreNativeFailure(native?.upsert(payload)); } catch {
      // Optional presentation must never interrupt capture.
    }
  },
  end(meetingId: string): void {
    try { ignoreNativeFailure(native?.end(meetingId)); } catch {
      // A missing/failed bridge is the supported old-binary path.
    }
  },
  reconcile(activeMeetingId: string | null): void {
    try { ignoreNativeFailure(native?.reconcile(activeMeetingId)); } catch {
      // A missing/failed bridge is the supported old-binary path.
    }
  },
});
