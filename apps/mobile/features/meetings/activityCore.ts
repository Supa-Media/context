export interface MeetingActivityPayload {
  meetingId: string;
  title: string;
  phase: "recording" | "paused";
  recordedMs: number;
  recordingSince: number | null;
}

export type MeetingActivityAction = "pause" | "resume" | "end";

export function activityActionFor(
  value: string | string[] | undefined,
  routeMeetingId: string,
  liveMeetingId: string | null,
): MeetingActivityAction | null {
  if (typeof value !== "string" || routeMeetingId === "" || routeMeetingId !== liveMeetingId) {
    return null;
  }
  return value === "pause" || value === "resume" || value === "end" ? value : null;
}
