import { requireOptionalNativeModule } from "expo-modules-core";
import { activityActionFor, type MeetingActivityPayload } from "./activityCore";

interface ContextActivityKitModule {
  isAvailable(): boolean;
  upsert(payload: MeetingActivityPayload & { generation: number }): Promise<void>;
  end(meetingId: string, generation: number): Promise<void>;
  reconcile(activeMeetingId: string | null, generation: number): Promise<void>;
}

const native = requireOptionalNativeModule<ContextActivityKitModule>("ContextActivityKit");
let generation = 0;

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
    try { ignoreNativeFailure(native?.upsert({ ...payload, generation: ++generation })); } catch {
      // Optional presentation must never interrupt capture.
    }
  },
  end(meetingId: string): void {
    try { ignoreNativeFailure(native?.end(meetingId, ++generation)); } catch {
      // A missing/failed bridge is the supported old-binary path.
    }
  },
  reconcile(activeMeetingId: string | null): void {
    try { ignoreNativeFailure(native?.reconcile(activeMeetingId, ++generation)); } catch {
      // A missing/failed bridge is the supported old-binary path.
    }
  },
});
