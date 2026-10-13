/**
 * Which communications view, if any, a console path belongs to.
 *
 * `docs/decisions/communications.md` decided the on-bucket shape; this is the
 * one place the console reads it back to decide what to draw instead of the
 * generic file browser's `NoteEditor` for a note.
 *
 * **Folders are never routed here.** `0-inbox`, each channel folder and
 * `0-inbox/contacts` are drawn by the same `FolderView` as every other folder
 * (Dev2, 2026-09-28: the Inbox's own list of rows "looks broken" beside every
 * other folder). Only a channel-day note has a view of its own.
 *
 * **Nor are contact pages, any more.** They open in the editor like every
 * other note, with a small header over the body (`ContactHeader.tsx`,
 * `contactPages.ts`) — the owner, 2026-10-12, as contacts moved into A–Z
 * letter folders. See `docs/decisions/app-and-console/communications-console.md`.
 *
 * The recogniser here is a **path predicate over the same shape
 * `@context/communications` already exports**, never a second implementation
 * of "is this a channel-day note" — see `apps/mcp/src/communications/paths.js`'s
 * own header for why two implementations of one shape is how they end up
 * disagreeing.
 */

import { parseChannelDayPath } from "@context/communications";
import type { CommsChannel } from "./types";

export type CommsRoute = {
  kind: "channel-day";
  channel: CommsChannel;
  account: string;
  date: string;
  part: number;
};

/**
 * What a path is, for the communications console — or `null` when it is an
 * ordinary note or folder the generic browser already knows how to show.
 *
 * Meeting notes are `null` too: one file per meeting, not one per day, so
 * there is no channel-day shape to route them to.
 */
export function classifyCommsPath(path: string): CommsRoute | null {
  const day = parseChannelDayPath(path);
  if (day === null) return null;
  // `day.channel` is `string` to the type checker — `CHANNELS` carries no
  // JSDoc annotation for `allowJs` to narrow from — but `parseChannelDayPath`
  // only ever returns one of the three real channels; `paths.test.ts` holds
  // that promise rather than this cast alone.
  return {
    kind: "channel-day",
    channel: day.channel as CommsChannel,
    account: day.account,
    date: day.date,
    part: day.part,
  };
}
