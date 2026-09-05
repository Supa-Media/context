/**
 * The status bar's content, as data.
 *
 * No React and no `react-native` import, for the same reason `editor.ts` has
 * none: the console's Jest suite runs in plain node, and the interesting rules
 * here are about *what a person is told*, not about how it is painted.
 *
 * One of those rules is load-bearing rather than cosmetic. `CLAUDE.md`:
 *
 *   > R2 supports `onlyIf: { etagMatches }` natively and AWS S3 supports
 *   > conditional `If-Match` writes; **B2 and Wasabi do not reliably.** Probe
 *   > capability at connect time and degrade honestly — never silently drop
 *   > conflict detection.
 *
 * "Degrade honestly" has to be visible somewhere or it is not honest, and this
 * strip is where. A bucket that cannot do a conditional write still saves, and
 * still usually catches a conflict — but "usually" is a different promise from
 * "atomically", and the person typing is the one who should get to know which
 * one they are living under. So the `read-compare` segment is `warn`, it says
 * what the weaker check actually does, and it is never omitted.
 *
 * Nothing here may carry note text. This repository is public and the same rule
 * that keeps note content out of structured logs keeps it out of the UI chrome:
 * counts and states are derived *from* the draft, never quoted from it.
 */

import type { EditorState } from "./editor";
import type { ConflictCheck } from "./types";
import { connectionLine, queueLine, type SyncFacts } from "../../offline/copy";

export interface StatusFacts {
  editor: EditorState;
  /** From the last SaveResult. `undefined` until something has been saved. */
  conflictCheck?: ConflictCheck;
  /** "R2 · brain", or null when no bucket is bound. */
  storageLabel: string | null;
  /**
   * How much of this context is in the hosted fast-search index — already
   * worded, already toned — or `null` when this viewer is told nothing.
   *
   * **Words in, not a status object**, for exactly the reason `storageLabel`
   * is a string: they are decided once, by `describeIndexProgress` in
   * `features/console/search/fastSearch.ts`, and every surface that draws them
   * reads that one function. Three call sites doing their own arithmetic over
   * `notesIndexed / notesPending` is how one context comes to be 62% here, 63%
   * in the settings card and 61% under the file tree — and a progress figure
   * whose whole job is to be compared with the last one you saw cannot afford
   * that.
   *
   * **`null` means draw nothing, and it is a privacy rule at least as often as
   * it is a loading one.** The backfill counters are owner-only: the index
   * counts every note the context has, private notes included, while a member
   * may read only the `team` tier, so handing them a percentage of that total
   * is handing them the size of what they are not being shown. A member gets
   * `null` and this strip omits the segment. An em dash, a `0%` or a skeleton
   * in its place would say a figure exists and is being kept from them, which
   * is most of what the figure itself would have said.
   *
   * Optional so a console with no fast-search subscription behind it — the
   * landing page's picture of one — simply has no opinion, exactly as `sync`
   * is optional there.
   */
  index?: { label: string; detail: string; tone: "quiet" | "warn" } | null;
  /** Wall-clock ms, passed in so this stays pure and testable. */
  now: number;
  /** When the open note was last saved in this session. */
  savedAt?: number;
  /**
   * The connection, and the writes that have not reached the bucket.
   *
   * Absent on a console with no offline layer under it — the landing page's
   * demo, which has no bucket to be offline from. The sentences themselves live
   * in `features/offline/copy.ts` beside the states they describe; this decides
   * where they sit and in what tone.
   */
  sync?: SyncFacts;
}

export type StatusTone = "quiet" | "ok" | "warn" | "crit";

export interface StatusSegment {
  id:
    | "connection"
    | "queue"
    | "words"
    | "characters"
    | "save"
    | "index"
    | "conflictCheck"
    | "storage";
  text: string;
  tone: StatusTone;
  /** Longer explanation for a tooltip / a tap. */
  detail?: string;
}

/**
 * Words in a draft.
 *
 * Whitespace runs separate words, leading and trailing whitespace is not a
 * word, and a hyphenated or apostrophised word is one word — the split is on
 * space, not on punctuation, because "read-compare" is one thing a person
 * wrote and counting it as two would be surprising in a way no reader benefits
 * from.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * `text.length` — **UTF-16 code units**, which is what JavaScript counts and
 * what the editor holds for the exact string handed to the bucket adapter to be
 * encoded. It is deliberately not described to the person as "characters you
 * can see": an emoji outside the BMP is two code units, and a combining
 * sequence is several, so this is not a grapheme count and must never be
 * labelled as one. It is also not a byte count — UTF-8 encoding happens below
 * this layer and inflates non-ASCII further.
 */
function countUnits(text: string): number {
  return text.length;
}

/** 1234 → "1,234". Written out rather than via `toLocaleString`, which varies. */
function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function plural(n: number, one: string, many: string): string {
  return `${group(n)} ${n === 1 ? one : many}`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now" → "N minutes ago" → "N hours ago" → "yesterday" → a plain date.
 *
 * A *future* `then` collapses to "just now" rather than counting down. Clocks
 * disagree: the timestamp may have come from a bucket, from another device, or
 * from a machine mid-NTP-correction, and "in -3 minutes" in a status bar is a
 * bug report about us rather than information about the note.
 */
export function relativeTime(then: number, now: number): string {
  const elapsed = now - then;
  if (elapsed < 45_000) return "just now";
  if (elapsed < HOUR) {
    return plural(Math.max(1, Math.round(elapsed / MINUTE)), "minute ago", "minutes ago");
  }
  if (elapsed < DAY) {
    return plural(Math.max(1, Math.floor(elapsed / HOUR)), "hour ago", "hours ago");
  }
  if (elapsed < 2 * DAY) return "yesterday";

  const d = new Date(then);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const stamp = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return sameYear ? stamp : `${stamp} ${d.getFullYear()}`;
}

/** The save segment, or `null` when nothing is open. */
function saveSegment(facts: StatusFacts): StatusSegment | null {
  const { editor, now, savedAt } = facts;
  const message = editor.message;

  switch (editor.status) {
    case "empty":
      // Nothing open, so there is nothing to say about saving. An idle "Saved"
      // against no note would be a claim about a file that is not there.
      return null;

    case "clean":
      /*
        A note read off the device is not "Saved", and calling it that is the
        console telling somebody their context contains something it does not.
        The word changes, the tone changes, and how old the copy is goes in the
        detail — `message` carries it, set by `opened`.
      */
      if (editor.fromCache === true) {
        return { id: "save", text: "Cached copy", tone: "warn", detail: message };
      }
      return {
        id: "save",
        text: savedAt === undefined ? "Saved" : `Saved ${relativeTime(savedAt, now)}`,
        tone: "quiet",
        detail: message,
      };

    case "dirty":
      return {
        id: "save",
        text: "Unsaved changes",
        tone: "warn",
        detail: "Your edits are in this editor only until you save them.",
      };

    case "saving":
      return {
        id: "save",
        text: "Saving…",
        tone: "quiet",
        detail: "Writing to your bucket.",
      };

    case "saved":
      return { id: "save", text: "Saved", tone: "ok", detail: message };

    case "queued":
      /*
        `warn`, never `ok`. A queued draft is written down and is not in the
        customer's bucket, and the whole product is that the bucket is the thing
        that is real — so this may not wear the same tone as a save that landed.
        What it is worth is in `message`, which changes with whether the store
        is durable.
      */
      return {
        id: "save",
        text: "Queued",
        tone: "warn",
        detail: message ?? "Waiting for a connection. Not in your bucket yet.",
      };

    case "conflict":
      return {
        id: "save",
        text: "Conflict",
        tone: "crit",
        detail:
          message ??
          "Somebody else wrote this note while you had it open. Your draft is kept — reload theirs, or overwrite it.",
      };

    case "error":
      return {
        id: "save",
        text: "Not saved",
        tone: "crit",
        detail: message ?? "The last save did not complete. Your draft is intact.",
      };
  }
}

/**
 * How the last save checked for a conflict, and what that is worth.
 *
 * Absent only while nothing has been saved yet — in particular it is **never**
 * dropped for `read-compare`, and `read-compare` is never `quiet`. Hiding the
 * weaker guarantee, or dressing it in the same tone as the strong one, is the
 * silent degradation the engineering standard forbids.
 */
function conflictCheckSegment(check: ConflictCheck | undefined): StatusSegment | null {
  if (check === undefined) return null;

  if (check === "conditional") {
    return {
      id: "conflictCheck",
      text: "Conditional writes",
      tone: "quiet",
      detail:
        "This bucket checks the version as part of the write itself. If somebody else saved first, your save is refused instead of overwriting them.",
    };
  }

  return {
    id: "conflictCheck",
    text: "Read-compare writes",
    tone: "warn",
    detail:
      "This provider cannot do conditional writes, so a conflict is caught by re-reading the note immediately before writing. A save by somebody else that lands in the gap between that read and the write can still be missed.",
  };
}

/**
 * Everything the strip shows, in reading order.
 *
 * The trailing three — `index`, `conflictCheck` and `storage` — are the facts
 * about *this context* rather than about the open note, which is why they sit
 * apart from the counts in the rendered bar.
 *
 * `index` leads that group and is deliberately **not** adjacent to `storage`.
 * The two describe different objects: the bucket is the customer's, and the
 * fast-search index is a copy in a database Supa Media runs. "R2 · brain · 62%
 * indexed" run together reads as 62% of the bucket, which is a claim about
 * somebody's own storage that nothing has measured — the exact species of
 * invention issue #25 was about.
 */
export function statusSegments(facts: StatusFacts): StatusSegment[] {
  const segments: StatusSegment[] = [];
  const { editor } = facts;

  /*
    First, before the counts, because they are facts about whether anything on
    this screen can reach the bucket at all — and because a person who has lost
    signal should not have to read past a word count to find that out.
  */
  if (facts.sync !== undefined) {
    const connection = connectionLine(facts.sync);
    if (connection !== null) {
      segments.push({
        id: "connection",
        text: connection.text,
        tone: "warn",
        detail: connection.detail,
      });
    }
    const queue = queueLine(facts.sync);
    if (queue !== null) {
      segments.push({ id: "queue", text: queue.text, tone: queue.tone, detail: queue.detail });
    }
  }

  // Counts describe an open note. With nothing open they would be zeroes about
  // no file.
  if (editor.path !== null) {
    segments.push({
      id: "words",
      text: plural(countWords(editor.draft), "word", "words"),
      tone: "quiet",
    });
    segments.push({
      id: "characters",
      text: plural(countUnits(editor.draft), "character", "characters"),
      tone: "quiet",
      // Says what is counted, without claiming graphemes or bytes.
      detail: "Counted in UTF-16 code units, so an emoji counts as more than one.",
    });
  }

  const save = saveSegment(facts);
  if (save) segments.push(save);

  /*
    How much of this context is in the hosted index.

    Absent unless there is something honest to say — the label is `null` for a
    member (owner-only census), for a context with fast search off (no index,
    so no proportion of one), and before the status has answered. There is no
    placeholder: the segment is simply not there, which is the same treatment
    `storage` gets for a missing label one block down.

    `quiet` while it is progressing, because a backfill running is the
    ordinary case and a toned chip on it is a badge somebody clears by turning
    on a copy of their private notes. The one exception is a backfill that
    stopped: `failed` is the state with a Try again behind it in settings, and
    the strip saying so in the same tone as a word count would be hiding it.
  */
  if (facts.index !== undefined && facts.index !== null) {
    segments.push({
      id: "index",
      text: facts.index.label,
      // The tone arrives with the words. Deriving it here — matching on
      // "Stopped", say — would go quiet the day that copy is reworded, in the
      // direction where a failed backfill stops looking like one.
      tone: facts.index.tone,
      detail: facts.index.detail,
    });
  }

  const check = conflictCheckSegment(facts.conflictCheck ?? editor.conflictCheck);
  if (check) segments.push(check);

  if (facts.storageLabel !== null) {
    segments.push({
      id: "storage",
      text: facts.storageLabel,
      tone: "quiet",
      detail: "Your notes live in this bucket, which you own. Context is a tenant in it.",
    });
  }

  return segments;
}

/** The ids rendered against the trailing edge of the bar. */
export const TRAILING_SEGMENTS: ReadonlyArray<StatusSegment["id"]> = [
  "index",
  "conflictCheck",
  "storage",
];
