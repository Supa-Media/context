/**
 * The Channel view's data shaping: one channel's active days, newest first,
 * paged — split parts collapse into one row.
 *
 * Meetings are deliberately not shaped here. A channel-day note is one file
 * standing for a whole day; a meeting note is one file standing for one
 * meeting, and several can land on the same date with nothing in common
 * beyond it. Turning that into "a day" row would need a day-of-meetings view
 * nobody asked for, so `0-inbox/meetings` keeps using the console's ordinary
 * folder listing — `classifyCommsPath` never routes it here — and only its
 * recency counts toward the Inbox row `inbox.ts` builds. See
 * `docs/decisions/app-and-console.md`.
 */

import { parseChannelDayPath } from "@context/communications";
import type { FileEntry } from "../files/types";
import type { ChannelDayRow, CommsChannel } from "./types";

/**
 * One row per active day, newest first.
 *
 * `path` is the lowest-numbered part actually present in `entries` — part 1
 * whenever it is there, which is the common case and the path every existing
 * link into the day already resolves to. Falling back to whichever part *is*
 * loaded, rather than requiring part 1, matters for a folder listing that
 * page-truncated before reaching it: the row still opens something real
 * rather than a path this listing never saw.
 */
export function collateChannelDays(
  channel: CommsChannel,
  account: string,
  entries: readonly FileEntry[],
): ChannelDayRow[] {
  const byDate = new Map<string, { path: string; minPart: number; parts: number }>();
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const day = parseChannelDayPath(entry.path);
    if (day === null || day.channel !== channel || day.account !== account) continue;

    const existing = byDate.get(day.date);
    if (existing === undefined) {
      byDate.set(day.date, { path: entry.path, minPart: day.part, parts: 1 });
      continue;
    }
    existing.parts += 1;
    if (day.part < existing.minPart) {
      existing.minPart = day.part;
      existing.path = entry.path;
    }
  }

  return [...byDate.entries()]
    .map(([date, value]) => ({
      channel,
      account,
      date,
      path: value.path,
      parts: value.parts,
      // Not derivable from a listing alone — a day's message and thread
      // counts live in its own frontmatter, and this view is a listing, not a
      // read of every day it names. `null` here is "not asked for", the same
      // meaning it carries on `ConsoleStorage`'s absent tiles.
      messages: null,
      threads: null,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** One page of rows, newest first. `page` is zero-based. */
export function pageChannelDays(
  rows: readonly ChannelDayRow[],
  page: number,
  pageSize: number,
): ChannelDayRow[] {
  const start = Math.max(0, page) * pageSize;
  return rows.slice(start, start + Math.max(0, pageSize));
}

/** How many pages `pageChannelDays` would produce. Always at least `1` unless `rows` is empty. */
export function channelDayPageCount(rows: readonly ChannelDayRow[], pageSize: number): number {
  if (rows.length === 0) return 0;
  return Math.ceil(rows.length / Math.max(1, pageSize));
}
