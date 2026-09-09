export { activityActionFor } from "./activityCore";
import type { MeetingActivityPayload } from "./activityCore";

/** Web, tests, and old non-iOS runtimes have no system recording surface. */
export const meetingActivity = Object.freeze({
  available: () => false,
  update: (_payload: MeetingActivityPayload) => {},
  end: (_meetingId: string) => {},
  reconcile: (_activeMeetingId: string | null) => {},
});
