/**
 * A GROUP CHAT'S MEMORY PAGE, THE ONE COPY OF ITS HISTORY (the owner, 2026-11-01).
 *
 * The owner chose: the chat's people still see what Tex remembers, as a page
 * in the chat's home in @context-lc, and that page is the only copy. Its text
 * lives in the chat's Durable Object like every Tex note
 * (`docs/decisions/texting-assistant/tex-durable-objects.md`), so the chat's
 * people read it, Download as folders carries it, and Tex reads it before it
 * answers and adds to it after. A change somebody makes there is what Tex
 * goes by (`groupMemoryCarry.js`).
 *
 * It holds what was asked, what Tex answered, and on a hidden line under each
 * answer the tools it used and the notes and pages it read or wrote
 * (`sources.js`). Here: where it is (`groupNotePath`), how to read it
 * (`parseGroupNote`, also how an old note in a workspace folder is carried in
 * once), and how to add to it without losing a write (`updateGroupPage`).
 */

import { readWithEtag, refusalWords } from "./jobLog.js";

export { GROUP_NOTES_FOLDER, groupNotePath, parseGroupNote, renderGroupNote, timedTurn } from "./groupPageFormat.js";
import { parseGroupNote, renderGroupNote } from "./groupPageFormat.js";

/**
 * The page's turns and version: `{turns, etag, missing}`, `turns` null when the page is there but is not one Tex can
 * read (its heading is gone). Null when it could not be read, which is never the same as a page with nothing on it.
 */
export async function readGroupPage(dispatch, path) {
  const seen = await readWithEtag(dispatch, path);
  if (seen === null) return null;
  if (seen.missing === true) return { turns: [], etag: null, missing: true };
  return { turns: parseGroupNote(seen.body), etag: seen.etag, missing: false };
}

/** Writes the page takes before one is given up on: two more after a write another turn or person won. */
export const PAGE_TRIES = 3;

/**
 * The page with `change(turns)` written over it, at the version just read: a write another turn or a person landed
 * first is read again and `change` applied to that, so neither is lost. A page Tex cannot read is never written over
 * (somebody's own words may be on it). Whether it was written; a refusal is one structured line with the tool's
 * leading words, never the page's.
 */
export async function updateGroupPage(dispatch, path, change, { log = console.log, onRefused = null } = {}) {
  let reason = "unreadable";
  for (let attempt = 0; attempt < PAGE_TRIES; attempt += 1) {
    const page = await readGroupPage(dispatch, path);
    if (page === null) break;
    if (page.turns === null) {
      reason = "not_a_memory_page";
      break;
    }
    try {
      const content = renderGroupNote(change(page.turns));
      const result = await dispatch("write_note", { path, content, ...(page.missing ? {} : { expected_etag: page.etag }) });
      if (result?.isError !== true) return true;
      reason = refusalWords(result);
      if (reason !== "conflict") break;
    } catch (error) {
      reason = error?.name ?? "error";
      break;
    }
  }
  const code = reasonCode(reason);
  log(JSON.stringify({ event: "group_memory_page_not_written", reason: code }));
  if (typeof onRefused === "function") onRefused(code);
  return false;
}

/**
 * A refusal's leading words as a code a public log keeps (`.github/workflows/agent-logs.yml` prints anything else as
 * `other`): "permission denied" is `permission_denied`. Only the words before the first `:`, newline or `(`, as
 * `refusalWords` already cuts them, and never more than 40 characters.
 */
export function reasonCode(words) {
  return String(words ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "") || "refused";
}
