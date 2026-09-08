// The link-from-meeting half of "a captured meeting matches a calendar
// event": given a meeting's own start/end/title and a set of candidate
// events (an already-read day's worth, or two — a meeting starting at 23:55
// can match an event the calendar owner's timezone puts on the *next* day),
// decide which one, if any, it is — and hand back the wikilink to attach.
//
// The other half — the desktop app *noticing* a meeting is starting, by
// consulting a calendar day note as one more detection signal — is
// deliberately not built here. `docs/decisions/meetings.md`, "Detection
// judgement is a pure function, and the desktop app only collects evidence"
// already draws that line for every other signal; a calendar day note is one
// more thing detection may *read*, and reading a note is not a job this
// package takes on for any of its other consumers either.
//
// This module never writes a note; `attachEventLink` below produces the new
// *text* of one, for the caller to store.
//
// ## Why a text patch, and not `renderMeetingNote(session)`
//
// `packages/meetings` gained an `event` frontmatter key for this (see
// `FRONTMATTER_KEYS` in `../../meetings/src/note.js`), and the obvious way to
// set it looks like "load the session, set `.event`, render again." That is
// wrong for the same reason `## My notes` is never rewritten: by the time a
// calendar sync runs, the meeting session that produced the note may not
// exist anywhere any more — the phone finished uploading it and dropped its
// local copy, or the note was written by a client this repository does not
// own the source of at all (three surfaces write a meeting note today, and a
// fourth is "soon"; `attachEventLink` works on the file every one of them
// produces, without needing to agree on a session shape). So this is a
// **text patch**: find the closing `---` of an existing frontmatter block and
// insert or replace one `event:` line in front of it, leaving every other
// byte — including a transcript nobody wants re-parsed just to add a link —
// untouched.

import { eventAnchor } from "./anchors.js";
import { calendarDayNotePath } from "./paths.js";

/** Two-way tolerance around a meeting's own timing, before it is not "the same event". */
export const DEFAULT_WINDOW_TOLERANCE_MS = 15 * 60 * 1000;

/** Below this title similarity, a time-window match alone is not enough. */
export const DEFAULT_MIN_TITLE_SCORE = 0.2;

/** Lowercased, punctuation stripped to spaces, collapsed — for comparing two titles, never for display. */
export function normalizeTitleWords(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Jaccard similarity over each title's word set: `|intersection| / |union|`,
 * 0 when either title has no words. Simple on purpose — this is a tie-break
 * alongside a time-window match, not the whole of the decision, and a
 * dependency-free word-set overlap needs no fuzzy-matching library for that.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function titleSimilarity(a, b) {
  const wordsA = new Set(normalizeTitleWords(a));
  const wordsB = new Set(normalizeTitleWords(b));
  if (!wordsA.size || !wordsB.size) return 0;
  let intersection = 0;
  for (const word of wordsA) if (wordsB.has(word)) intersection += 1;
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Do two `[start, end)` instant ranges overlap, allowing `toleranceMs` of slack on each side? */
export function windowsOverlap(aStart, aEnd, bStart, bEnd, toleranceMs = DEFAULT_WINDOW_TOLERANCE_MS) {
  const as = Date.parse(String(aStart ?? ""));
  const bs = Date.parse(String(bStart ?? ""));
  if (!Number.isFinite(as) || !Number.isFinite(bs)) return false;
  // A meeting or event with no end is treated as a point in time — a
  // conservative floor, so an open-ended meeting only matches an event whose
  // window actually contains that point.
  const ae = Number.isFinite(Date.parse(String(aEnd ?? ""))) ? Date.parse(String(aEnd)) : as;
  const be = Number.isFinite(Date.parse(String(bEnd ?? ""))) ? Date.parse(String(bEnd)) : bs;
  return as - toleranceMs <= be + toleranceMs && bs - toleranceMs <= ae + toleranceMs;
}

/**
 * The best calendar event for one meeting, or `null`.
 *
 * A candidate must overlap the meeting's time window (with tolerance, because
 * a recorder is started by a person joining a call, not by the calendar) —
 * that is the gate. Title similarity then breaks ties among the events that
 * pass it and refuses a match with no title resemblance at all, so a meeting
 * that happens to run during a back-to-back calendar day does not silently
 * attach to the wrong neighbour. The closest-starting candidate wins a tie in
 * both time and title.
 *
 * @param {{title?: string, startedAt: string, endedAt?: string|null}} meeting
 * @param {Array<{anchor: string, title?: string, start: string, end?: string|null, path: string}>} candidates
 * @param {{toleranceMs?: number, minTitleScore?: number}} [options]
 * @returns {{anchor: string, path: string, score: number}|null}
 */
export function matchMeetingToEvent(meeting, candidates, options = {}) {
  const toleranceMs = options.toleranceMs ?? DEFAULT_WINDOW_TOLERANCE_MS;
  const minTitleScore = options.minTitleScore ?? DEFAULT_MIN_TITLE_SCORE;
  if (!meeting || !meeting.startedAt || !Array.isArray(candidates)) return null;

  const overlapping = candidates.filter((candidate) =>
    windowsOverlap(meeting.startedAt, meeting.endedAt, candidate.start, candidate.end, toleranceMs)
  );
  if (!overlapping.length) return null;

  let best = null;
  for (const candidate of overlapping) {
    const score = titleSimilarity(meeting.title, candidate.title);
    // A single overlapping candidate is accepted on the time window alone —
    // a meeting recorded during exactly one calendar event, whatever either
    // was titled, is almost certainly that event. With more than one
    // overlapping candidate, title similarity is what tells them apart, so
    // the threshold only applies once there is a choice to make.
    if (overlapping.length > 1 && score < minTitleScore) continue;
    const startDelta = Math.abs(Date.parse(meeting.startedAt) - Date.parse(candidate.start));
    if (
      best === null ||
      score > best.score ||
      (score === best.score && startDelta < best.startDelta)
    ) {
      best = { anchor: candidate.anchor, path: candidate.path, score, startDelta };
    }
  }
  return best ? { anchor: best.anchor, path: best.path, score: best.score } : null;
}

/**
 * The wikilink a matched meeting note gains — `[[0-inbox/calendar/<date>#evt-…]]`,
 * the same `[[path#anchor]]` form every other anchor link in this product
 * uses, so `links.js` resolves and rewrites it like any other.
 *
 * @param {string} path
 * @param {string} anchor
 * @returns {string}
 */
export function calendarEventLink(path, anchor) {
  const withoutExtension = String(path ?? "").replace(/\.md$/, "");
  return `[[${withoutExtension}#${anchor}]]`;
}

/**
 * Candidate events for one meeting: every event on the calendar day(s) the
 * meeting's own start falls on, in the owner's timezone — today and, since a
 * meeting starting just before midnight can match an event the provider
 * files under the next day, the adjacent day too. The caller supplies
 * `readDay(date) -> CalendarEventInstance[] | null` (a day with no note reads
 * as `null`, same as anywhere else in this package that only knows what is on
 * disk); this function does no I/O itself.
 *
 * @param {{date: string, events: import("./protocol.js").CalendarEventInstance[]}} day
 * @param {{root?: string}} [options]
 * @returns {Array<{anchor: string, title?: string, start: string, end?: string|null, path: string}>}
 */
export function candidatesFromDay(day, options = {}) {
  if (!day || !Array.isArray(day.events)) return [];
  const path = calendarDayNotePath({ date: day.date }, options);
  return day.events
    .filter((event) => event?.status !== "cancelled" && (event?.start?.dateTime || event?.start?.date))
    .map((event) => ({
      anchor: eventAnchor(event),
      title: event.title,
      start: event.start.dateTime ?? `${event.start.date}T00:00:00.000Z`,
      end: event.end?.dateTime ?? (event.end?.date ? `${event.end.date}T00:00:00.000Z` : null),
      path,
    }));
}

/** A JSON string literal — the same double-quoted scalar every frontmatter value in this product uses. */
function yamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

/** Where the frontmatter block ends, or `-1` if this text does not open with one. */
function frontmatterEnd(lines) {
  if (lines[0] !== "---") return -1;
  for (let i = 1; i < lines.length; i += 1) if (lines[i] === "---") return i;
  return -1;
}

/**
 * The current `event:` frontmatter value of a meeting note, or `null` when
 * there is none — absent and empty are the same answer here, the same way
 * they are the same sentence to a reader of the key itself.
 *
 * @param {string} noteText
 * @returns {string|null}
 */
export function readEventLink(noteText) {
  const lines = String(noteText ?? "").split("\n");
  const end = frontmatterEnd(lines);
  if (end === -1) return null;
  for (let i = 1; i < end; i += 1) {
    if (!lines[i].startsWith("event:")) continue;
    const raw = lines[i].slice("event:".length).trim();
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      try {
        const value = JSON.parse(raw);
        return typeof value === "string" && value ? value : null;
      } catch {
        return null;
      }
    }
    return raw || null;
  }
  return null;
}

/**
 * Set (or replace) a meeting note's `event:` frontmatter key, as a text
 * patch — see this file's header for why a patch rather than a re-render.
 *
 * Idempotent: setting the link a note already carries returns the input
 * unchanged, byte for byte, so a caller can call this on every sync without
 * ever producing a no-op write into somebody's version history.
 *
 * A note with no frontmatter block at all (hand-written, or from a format
 * this function does not recognise) is returned unchanged rather than guessed
 * at — inserting a frontmatter block is a different, larger operation than
 * this one, and the caller can tell the two apart because the text it gets
 * back is identical to what it passed in.
 *
 * @param {string} noteText
 * @param {string} link From `calendarEventLink`.
 * @returns {string}
 */
export function attachEventLink(noteText, link) {
  const text = String(noteText ?? "");
  const value = String(link ?? "");
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  if (end === -1) return text;

  for (let i = 1; i < end; i += 1) {
    if (!lines[i].startsWith("event:")) continue;
    const newLine = `event: ${yamlScalar(value)}`;
    if (lines[i] === newLine) return text;
    const next = [...lines];
    next[i] = newLine;
    return next.join("\n");
  }

  // No `event:` key yet — insert it as the last frontmatter line, immediately
  // before the closing `---`, so a note from before this key existed and one
  // written today differ by exactly one inserted line and nothing else.
  const next = [...lines.slice(0, end), `event: ${yamlScalar(value)}`, ...lines.slice(end)];
  return next.join("\n");
}
