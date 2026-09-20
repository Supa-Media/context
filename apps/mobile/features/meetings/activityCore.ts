export interface MeetingActivityPayload {
  meetingId: string;
  /** One-use capability required by every recorder-control deep link. */
  controlToken: string;
  title: string;
  phase: "recording" | "paused";
  recordedMs: number;
  recordingSince: number | null;
}

export type MeetingActivityAction = "pause" | "resume" | "end";

export interface MeetingActivityController {
  available(): boolean;
  update(payload: MeetingActivityPayload): void;
  end(meetingId: string): void;
  reconcile(activeMeetingId: string | null): void;
}

export function activityActionFor(
  value: string | string[] | undefined,
  routeMeetingId: string,
  liveMeetingId: string | null,
  controlToken: string | string[] | undefined,
): MeetingActivityAction | null {
  if (
    typeof value !== "string" ||
    routeMeetingId === "" ||
    routeMeetingId !== liveMeetingId ||
    typeof controlToken !== "string" ||
    !/^[0-9a-f]{64}$/i.test(controlToken)
  ) {
    return null;
  }
  return value === "pause" || value === "resume" || value === "end" ? value : null;
}
