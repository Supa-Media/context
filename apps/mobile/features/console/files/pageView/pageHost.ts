/**
 * The app's half of the page runtime: where the frame is loaded from, what it
 * may say, and what each thing it says does to the note.
 *
 * The frame (`apps/mobile/page-frame/`) draws a `.page.md` note in a sealed
 * origin and reports what the reader did. Everything it says is checked here
 * twice: once for shape (`readPageMessage`, because the frame runs on a note
 * anybody who can write to it wrote), and once against the note as it is now
 * (`pageChange`, through `@context/shared/src/pages/edits.cjs`), so the frame
 * can only change words a reader sees, tick a task the note has, or pick an
 * option a block offers. Comments are written by `comments.cjs`, as the
 * signed-in person, exactly as the editor writes them.
 *
 * Decision: `docs/decisions/app-and-console/pages.md`.
 */

import { addThread, appendEvent, applyChanges } from "@context/shared/src/comments.cjs";
import { applyRunEdits, castVote, chooseOption, commentableRange, toggleTask } from "@context/shared/src/pages/index.cjs";

import type { PageMessage } from "./pageWire";

export { LOCAL_FRAME_PATH, PAGE_CHANNEL, PAGE_MAX_HEIGHT, dialUrl, pageFrameUrls, readPageMessage, type PageMessage } from "./pageWire";

export type PageChange = { text: string } | { error: string };

/**
 * The note after one thing the reader did, or why not. `shown` is the copy of
 * the note the frame drew; a message about any other copy is stale, because
 * its positions are positions in that copy.
 */
export function pageChange(current: string, shown: string, message: PageMessage, author: string | null): PageChange | null {
  if (current !== shown) {
    if (message.type === "edit" || message.type === "task" || message.type === "choose" || message.type === "vote" || message.type === "comment") return { error: "stale" };
  }
  switch (message.type) {
    case "edit":
      return applyRunEdits(current, message.edits);
    case "task":
      return toggleTask(current, message.at, message.checked);
    case "choose":
      return chooseOption(current, message.block, message.option);
    case "vote":
      // Cast as the signed-in person: the frame says which option, never whose vote.
      if (author === null) return { error: "Sign in to vote." };
      return castVote(current, message.block, message.option, author);
    case "comment": {
      if (author === null) return { error: "This note can't take comments here." };
      if (!commentableRange(current, message.from, message.to)) return { error: "stale" };
      const made = addThread(current, { from: message.from, to: message.to, author, body: message.body });
      return made.error !== undefined ? { error: made.error } : { text: applyChanges(current, made.changes) };
    }
    case "reply":
    case "resolve":
    case "reopen": {
      if (author === null) return { error: "This note can't take comments here." };
      const kind = message.type === "reply" ? "comment" : message.type === "resolve" ? "resolved" : "reopened";
      const done = appendEvent(current, { thread: message.thread, kind, author, body: message.body || undefined });
      return done.error !== undefined ? { error: done.error } : { text: applyChanges(current, done.changes) };
    }
    default:
      return null;
  }
}
