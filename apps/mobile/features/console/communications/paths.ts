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
 * other folder). Only the two *notes* with a shape of their own, a channel-day
 * and a contact page, get a view.
 * Every recogniser here is a **path predicate over the same shapes
 * `@context/communications` and `@context/meetings` already export**, never a
 * second implementation of "is this a channel-day note" — see
 * `apps/mcp/src/communications/paths.js`'s own header for why two
 * implementations of one shape is how they end up disagreeing.
 */

import { CONTACTS_FOLDER, isContactNotePath, parseChannelDayPath } from "@context/communications";
import type { CommsChannel } from "./types";

export type CommsRoute =
  | { kind: "channel-day"; channel: CommsChannel; account: string; date: string; part: number }
  | { kind: "contact"; slug: string };

/**
 * What a path is, for the communications console — or `null` when it is an
 * ordinary note or folder the generic browser already knows how to show.
 *
 * Meeting notes are `null` too: one file per meeting, not one per day, so
 * there is no channel-day shape to route them to. The two shapes below cannot
 * overlap — a channel-day path is never a contact path.
 */
export function classifyCommsPath(path: string): CommsRoute | null {
  const day = parseChannelDayPath(path);
  if (day !== null) {
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

  if (isContactNotePath(path)) {
    return { kind: "contact", slug: path.slice(CONTACTS_FOLDER.length + 1, -".md".length) };
  }

  return null;
}
