/**
 * The day labels between the app chat's messages ("Yesterday", "Today", or a
 * date): one above the first line of each day, on this device's calendar, as
 * the in-app Tex mock draws them. Pure, so it is tested without a screen.
 */
import { dayKey, dayTitle } from "../history/historyLines";

/** Each line that starts a new day, with the label drawn above it. */
export function dayLabels<T extends { at: number }>(lines: readonly T[], now: Date): Map<T, string> {
  const out = new Map<T, string>();
  let last: string | null = null;
  for (const line of lines) {
    const key = dayKey(line.at);
    if (key !== last) out.set(line, dayTitle(key, now));
    last = key;
  }
  return out;
}
