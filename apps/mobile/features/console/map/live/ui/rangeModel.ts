/**
 * The custom range picker's arithmetic, by day. The activity strip has one bar
 * per day from the first day of history to today; a selection is a run of
 * those days, `[s, b)`, where `s` is the first day and `b` the boundary after
 * the last one. A `b` equal to the number of days is the present: the end
 * handle at the last boundary means "now". Pure, so the snapping, the one-day
 * minimum, the shortcut pills and the count under a selection are checked
 * without drawing anything. Local time throughout.
 */
import { dateText, nextDay, startOfDay, type Stretch } from "../replayClock";

export type DayCount = { at: number; count: number };

/** One bar per day: `starts[i]` is that day's local midnight, `counts[i]` its changes. The last day is today. */
export type Strip = { starts: number[]; counts: number[] };

export type Selection = { s: number; b: number };

/**
 * The strip from the first day of history to today. Days with nothing on them
 * are bars of zero, so the strip reads as time and not as a list of busy days.
 * With no history at all it is today alone.
 */
export function stripFor(days: readonly DayCount[], startsAt: number | null, now: number): Strip {
  const today = startOfDay(now);
  const earliest = Math.min(startsAt ?? Infinity, ...days.map((d) => d.at));
  const first = Number.isFinite(earliest) ? Math.min(startOfDay(earliest), today) : today;
  const counts = new Map<number, number>();
  for (const d of days) {
    const day = startOfDay(d.at);
    counts.set(day, (counts.get(day) ?? 0) + d.count);
  }
  const starts: number[] = [];
  for (let day = first; day <= today; day = nextDay(day)) starts.push(day);
  return { starts, counts: starts.map((day) => counts.get(day) ?? 0) };
}

/** The stretch a selection covers. A selection that reaches the present ends now. */
export function selectionStretch(sel: Selection, starts: readonly number[], now: number): Stretch {
  if (sel.b >= starts.length) return { from: starts[sel.s]!, to: now, open: true };
  return { from: starts[sel.s]!, to: starts[sel.b]!, open: false };
}

/** The days a stretch covers: a start in the middle of a day counts from that day, an end in the middle of one takes that day. */
export function stretchSelection(stretch: Stretch, starts: readonly number[]): Selection {
  const n = starts.length;
  let s = -1;
  for (let i = 0; i < n && starts[i]! <= stretch.from; i++) s = i;
  s = Math.max(0, Math.min(n - 1, s));
  let b = n;
  if (!stretch.open) {
    b = 0;
    for (let i = 0; i < n && starts[i]! < stretch.to; i++) b = i + 1;
  }
  return { s, b: Math.max(s + 1, Math.min(n, b)) };
}

/** A selection brought within a strip of `n` days, for when the history under it has changed length. */
export function fitSelection(sel: Selection, n: number): Selection {
  const s = Math.max(0, Math.min(sel.s, n - 1));
  return { s, b: Math.max(s + 1, Math.min(n, sel.b)) };
}

/** Drag the start handle to a boundary: never past the end, a day is the least. */
export function dragStart(sel: Selection, boundary: number, n: number): Selection {
  return { s: Math.max(0, Math.min(n - 1, Math.min(boundary, sel.b - 1))), b: sel.b };
}

/** Drag the end handle to a boundary: never before the start, a day is the least. */
export function dragEnd(sel: Selection, boundary: number, n: number): Selection {
  return { s: sel.s, b: Math.max(sel.s + 1, Math.min(n, boundary)) };
}

/** The keyboard: a handle moves `days`, with the same limits as a drag. */
export function nudge(sel: Selection, edge: "start" | "end", days: number, n: number): Selection {
  return edge === "start" ? dragStart(sel, sel.s + days, n) : dragEnd(sel, sel.b + days, n);
}

export type ShortcutKey = "3d" | "2w" | "30d" | "all";

export const SHORTCUTS: readonly { key: ShortcutKey; label: string; days: number }[] = [
  { key: "3d", label: "Past 3 days", days: 3 },
  { key: "2w", label: "Past 2 weeks", days: 14 },
  { key: "30d", label: "Past 30 days", days: 30 },
  { key: "all", label: "Everything", days: Infinity },
];

/** A shortcut's selection: its days up to now, or all of them. */
export function shortcutSelection(key: ShortcutKey, n: number): Selection {
  const days = SHORTCUTS.find((s) => s.key === key)!.days;
  return { s: Number.isFinite(days) ? Math.max(0, n - days) : 0, b: n };
}

/** The pills whose range the selection is exactly. A short history makes several of them the same range, and they all light. */
export function litShortcuts(sel: Selection, n: number): ShortcutKey[] {
  return SHORTCUTS.filter((s) => {
    const want = shortcutSelection(s.key, n);
    return want.s === sel.s && want.b === sel.b;
  }).map((s) => s.key);
}

/** The changes in the selected days. */
export function countIn(counts: readonly number[], sel: Selection): number {
  let total = 0;
  for (let i = sel.s; i < sel.b; i++) total += counts[i] ?? 0;
  return total;
}

/** "1,612 changes", "1 change". */
export function changesText(count: number): string {
  return `${String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} change${count === 1 ? "" : "s"}`;
}

/** The start field: "Thu 25 Sep, 00:00", the day and a 24-hour clock. */
export function startFieldText(t: number): string {
  const d = new Date(t);
  return `${dateText(t)}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
