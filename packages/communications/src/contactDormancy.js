// Archiving contact pages nobody has written to in a year (owner, 2026-10-12).
//
// A page this package renders whose newest dated activity is more than a year
// old is moved to the archive mirror — `0-inbox/contacts/c/claire.md` to
// `4-archive/0-inbox/contacts/c/claire.md` — and the contact lookup brings it
// back on that person's next message (`upsertContactDraft`). The archive is
// never chaos-scored, so the live folder holds the people the owner is in
// touch with.
//
// ## Where it runs, and what it re-asks
//
// Not on a clock of its own. Each sync writer that already holds a contact
// lookup for its pass — the Gmail and Google Chat forward passes, the desktop
// iMessage pass — calls `sweepDormantContacts` once at the end, after its own
// drafts, with the same lookup. The lookup already lists both folders and
// re-reads only pages whose version moved; it remembers each page's newest
// activity date and whether it waits on a `review:`, so finding candidates
// costs no read at all.
//
// The lookup is a cache, and nothing is decided from it. Each candidate is
// re-read immediately before it moves and checked again from its own bytes —
// still a page this package renders, still no `review:`, newest activity
// still older than the cutoff against the clock passed in now. Moves go
// through the caller's ordinary move, the one revival uses, so links follow
// and visibility is the narrower of the two folders.
//
// Bounded: at most `limit` pages are considered per pass, oldest first. A
// page whose move is refused (an archived copy already sits at the mirror
// path, say) is held back for a week, so it cannot take the batch's place in
// every pass. A failure ends this sweep and nothing else.

import { archivedContactPath, isCalendarDate } from "./paths.js";
import { isContactNote, parseContactView } from "./contacts.js";

/** No dated activity for this many days and a page is dormant. */
export const CONTACT_DORMANT_DAYS = 365;

/** At most this many pages are considered for the archive in one pass. */
export const CONTACT_SWEEP_BATCH = 25;

/** How long a page whose move was refused waits before the sweep tries it again. */
export const CONTACT_SWEEP_HOLD_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Frontmatter values that hold nothing, the same reading the chaos rubric gives `review:`. */
const EMPTY_VALUES = new Set(['""', "''", "[]", "{}", "null", "~", "false", "0"]);

/** `YYYY-MM-DD`, `days` before `now`, or `null` when `now` is not a time. */
function dateBefore(now, days) {
  const time = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(String(now ?? ""));
  if (!Number.isFinite(time)) return null;
  return new Date(time - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The newest date a page has activity on, `YYYY-MM-DD`, or `null` when it has
 * none — a line the renderer wrote `undated`, or no activity at all.
 */
export function newestActivityDate(text) {
  let newest = null;
  for (const { date } of parseContactView(text).activity) {
    if (isCalendarDate(date) && (newest === null || date > newest)) newest = date;
  }
  return newest;
}

/**
 * Whether the frontmatter's `review:` holds anything — a question the merge
 * swarm or a person left for the owner. An inline value counts unless it is
 * one of the empty spellings; a bare `review:` counts when something is
 * indented beneath it.
 */
export function hasPendingReview(text) {
  const source = String(text ?? "");
  if (!source.startsWith("---\n")) return false;
  const end = source.indexOf("\n---", 3);
  if (end === -1) return false;
  const lines = source.slice(4, end).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^review\s*:(.*)$/.exec(lines[index]);
    if (!match) continue;
    const value = match[1].trim();
    if (value !== "") return !EMPTY_VALUES.has(value);
    const next = lines[index + 1];
    return next !== undefined && /^\s+\S|^-\s*\S/.test(next);
  }
  return false;
}

/** The newest activity date a page may have and still be dormant is the day before this one. */
export function dormancyCutoff(now) {
  return dateBefore(now, CONTACT_DORMANT_DAYS);
}

/**
 * Whether these bytes, read now, are a page the sweep may archive: one this
 * package renders, waiting on no review, with dated activity and none of it
 * since the cutoff. Owner-written `## Notes` do not keep a page live — the
 * archive is recoverable and the next message brings the page, notes and all,
 * back.
 */
export function isDormantContactPage(text, now) {
  const cutoff = dormancyCutoff(now);
  if (cutoff === null || !isContactNote(text) || hasPendingReview(text)) return false;
  const newest = newestActivityDate(text);
  return newest !== null && newest < cutoff;
}

/**
 * Move up to `limit` dormant contact pages into the archive mirror.
 *
 * `io` is the writer's storage, the same shape `upsertContactDraft` takes:
 *  - `read(path)` → `{text, etag}` or `null`;
 *  - `move(from, to, etag)` → `{ok: boolean, message?}`, the writer's ordinary move.
 *
 * Never throws for one page: a refused move is counted and held back, and a
 * thrown read or move ends the batch (the store is probably unreachable) with
 * what was done so far. A listing that fails throws, as the lookup's does.
 *
 * @param {ReturnType<import("./contactLookup.js").createContactLookup>} lookup
 * @param {{now: Date|string|number, limit?: number, root?: string}} options
 * @returns {Promise<{archived: string[], kept: number, failed: number}>}
 */
export async function sweepDormantContacts(lookup, io, options = {}) {
  const result = { archived: [], kept: 0, failed: 0 };
  const cutoff = dormancyCutoff(options.now);
  const today = dateBefore(options.now, 0);
  const limit = options.limit ?? CONTACT_SWEEP_BATCH;
  if (cutoff === null || !(limit > 0)) return result;
  const candidates = await lookup.dormantPages(cutoff, dateBefore(options.now, CONTACT_SWEEP_HOLD_DAYS));
  for (const path of candidates.slice(0, limit)) {
    const target = archivedContactPath(path, { root: options.root });
    if (target === null) continue;
    try {
      const page = await io.read(path);
      if (page === null || !isDormantContactPage(page.text, options.now)) {
        // It gained activity, a review, or the owner's own words since the
        // lookup last read it: the lookup learns that, and the page stays.
        lookup.record(path, page === null ? null : page.text);
        result.kept += 1;
        continue;
      }
      const moved = await io.move(path, target, page.etag);
      if (!moved?.ok) {
        lookup.holdBack(path, today);
        result.failed += 1;
        continue;
      }
      lookup.record(path, null);
      lookup.record(target, page.text);
      result.archived.push(target);
    } catch {
      result.failed += 1;
      break;
    }
  }
  return result;
}
