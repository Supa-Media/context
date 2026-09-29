/**
 * The last few minutes of what the app did, kept on this device for one reason:
 * a feedback report can carry it when the person reporting leaves the box
 * ticked (`features/feedback/`).
 *
 * It holds only what already went to Sentry and PostHog, in the same cleaned
 * form — route names from `telemetryRoute`, error names and references — so it
 * cannot become a second, richer telemetry stream. Memory only: nothing here
 * survives a reload, and nothing leaves the device unless a report sends it.
 */

export type ActivityKind = "screen" | "error";

export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  /** Already cleaned by the caller. Never a note path, title, handle or link. */
  text: string;
}

export const ACTIVITY_WINDOW_MS = 10 * 60 * 1000;
export const ACTIVITY_MAX_ENTRIES = 200;

let entries: ActivityEntry[] = [];

export function recordActivity(kind: ActivityKind, text: string, at = Date.now()): void {
  const last = entries.at(-1);
  // A screen reported twice in a row is one visit, as PostHog already treats it.
  if (last !== undefined && last.kind === kind && last.text === text && kind === "screen") return;
  entries.push({ at, kind, text });
  if (entries.length > ACTIVITY_MAX_ENTRIES) entries = entries.slice(-ACTIVITY_MAX_ENTRIES);
}

/** What happened in the last ten minutes, oldest first. */
export function recentActivity(now = Date.now()): ActivityEntry[] {
  return entries.filter((entry) => now - entry.at <= ACTIVITY_WINDOW_MS);
}

/** One line per entry, the way the report shows it and sends it. */
export function formatActivity(list: readonly ActivityEntry[]): string {
  return list
    .map((entry) => {
      const time = new Date(entry.at);
      const hh = String(time.getHours()).padStart(2, "0");
      const mm = String(time.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}  ${entry.kind === "screen" ? "opened" : "error "}  ${entry.text}`;
    })
    .join("\n");
}

/** Tests only. */
export function resetActivityForTests(): void {
  entries = [];
}
