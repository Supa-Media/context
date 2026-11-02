import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";

import { DEFAULT_ASK_BEFORE_MS, setShellAskBefore } from "./shellCalendar";

/**
 * Settings › Meetings, Joining from the calendar
 * (docs/decisions/meetings/joining-from-the-calendar.md): which calendars
 * offer Join, and how long before a meeting the Mac app asks. Kept on the
 * account (`functions/meetingPreferences.ts`), so a choice made on a phone
 * holds on the Mac.
 */

export type AskBefore = "1" | "5" | "never";

export const ASK_BEFORE_OPTIONS: readonly { key: AskBefore; label: string; ms: number | null }[] = Object.freeze([
  { key: "1", label: "1 minute before", ms: 60_000 },
  { key: "5", label: "5 minutes before", ms: 300_000 },
  { key: "never", label: "Don't ask", ms: null },
]);

export function askBeforeKey(ms: number | null): AskBefore {
  return ASK_BEFORE_OPTIONS.find((option) => option.ms === ms)?.key ?? "1";
}

export function askBeforeMs(key: AskBefore): 60_000 | 300_000 | null {
  return key === "5" ? 300_000 : key === "never" ? null : 60_000;
}

/**
 * Keep the Mac app's ask in step with the account, beside the meetings
 * source in the app gate. A person who never chose is asked a minute before.
 */
export function useMeetingJoinPreferencesSource({ enabled }: { enabled: boolean }): void {
  const row = useQuery(api.functions.meetingPreferences.myMeetingPreferences, enabled ? {} : "skip");
  useEffect(() => {
    if (row === undefined) return;
    setShellAskBefore(row === null ? DEFAULT_ASK_BEFORE_MS : row.askBeforeMs);
  }, [row]);
}
