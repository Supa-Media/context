/**
 * One incremental pass: new rows in, affected channel-day notes upserted.
 *
 * Everything that touches `chat.db` or the gateway is injected — `queryMessages`,
 * `queryAttachments`, `queryParticipants`, `readNote`, `writeNote` — so this
 * module is a pure reducer over its deps' answers, exactly like
 * `sync/outbox.ts`, and the suite drives it with fakes rather than a real Mac.
 * `main/imessage.ts` is the only file that supplies the real ones.
 *
 * ## The shape of one sync
 *
 *  1. Read every row **since the cursor** — this is the only unbounded-by-date
 *     query the whole file makes, and it exists only to answer one question:
 *     which UTC calendar days got new activity.
 *  2. For each affected day, re-read **that whole day** from `chat.db` and
 *     re-render it from scratch (`planChannelDay`) — never append to what was
 *     last written. `docs/decisions/communications.md`: *"regenerating only
 *     affected days"* is the promise; re-deriving a day from the source of
 *     truth rather than patching a stored note is what keeps a fixed
 *     late-arriving row and a fixed reader bug self-healing on the next sync
 *     instead of needing a backfill tool of their own.
 *  3. Write each part only if its rendered text actually differs from what is
 *     already there — see `daySameApartFromUpdatedLine` for what "differs"
 *     deliberately ignores. A day with no new content produces **zero**
 *     `writeNote` calls, which is the whole of what "idempotent upsert: re-
 *     running changes no bytes" asks for.
 *  4. A day that *shrank* — enough messages deleted on the Mac that it no
 *     longer splits into as many parts — has every part past its new last one
 *     **emptied**, so a message somebody deleted does not survive in an
 *     orphaned `-part-N.md` nobody re-renders. The file itself stays (this app
 *     does not delete a customer's notes) but its content does not; see
 *     `retireOrphanParts`.
 *  5. The cursor advances past every row this pass saw **only if every
 *     affected day wrote clean**. A day that failed keeps the old cursor in
 *     place, so the whole pass — not just the failed day — is retried next
 *     time; that costs a handful of redundant re-reads of days that already
 *     landed (harmless: they compare equal and write nothing) in exchange for
 *     never advancing past a row whose day silently never made it to the
 *     bucket.
 */

import { channelDayNotePath, planChannelDay, renderChannelDayNote, type CommunicationEvent } from "@context/communications";
import type { ChannelDayPart } from "@context/communications/protocol";
import { appleNsRangeForUtcDate, appleEpochNsToIso, utcDateOf } from "./appleTime.ts";
import { advanceCursor, type ImessageCursor } from "./cursor.ts";
import type { ReadNoteResult, WriteNoteResult } from "./gatewayNotes.ts";
import { isReactionRow, readChatDbWindow } from "./reader.ts";
import type { RawAttachmentRow, RawMessageRow, RawParticipantRow } from "./schema.ts";
import type { MessageWindow } from "./schema.ts";

export interface ImessageSyncDeps {
  queryMessages(window: MessageWindow): Promise<RawMessageRow[]>;
  queryAttachments(window: MessageWindow): Promise<RawAttachmentRow[]>;
  queryParticipants(): Promise<RawParticipantRow[]>;
  readNote(path: string): Promise<ReadNoteResult>;
  writeNote(path: string, content: string, expectedEtag: string | null): Promise<WriteNoteResult>;
  /** ISO now, for the `updated` frontmatter field of a note this pass actually writes. */
  now(): string;
  /** A fresh, unguessable nonce for a day that has never been written before. */
  mintNonce(): string;
  /** This device's own handles, so a group's owner is never listed as its own participant. */
  selfAddresses?: readonly string[];
}

export interface DayOutcome {
  date: string;
  status: "written" | "unchanged" | "error";
  parts: number;
  message?: string;
}

export interface SyncReport {
  cursor: ImessageCursor;
  /** Rows this pass read since the previous cursor. `0` means nothing to do. */
  newRows: number;
  days: DayOutcome[];
}

/** The exact line `renderChannelDayNote` writes for the fence's begin marker, with the nonce captured. */
const FENCE_BEGIN = /<!-- context:untrusted-communication begin (\S+) -->/;

/**
 * How far past a day's current last part `retireOrphanParts` will look.
 *
 * The scan stops at the first part that is not there, so on real data it costs
 * exactly one extra `read_note` per affected day. This bound exists for the
 * case where that stopping condition never arrives — a gateway answering
 * `found` for every path it is asked about — because an unbounded loop reading
 * a remote is a hang, and a hang is worse than the stale part it is trying to
 * clear. 64 parts past the living ones is roughly 32 MB of message text in one
 * day beyond what the day now renders, which no real day has ever lost.
 */
const MAX_ORPHAN_PARTS_SCANNED = 64;

/** The nonce a previously-written day used, so regenerating it reuses the same one. `null` for a day that never existed. */
export function existingNonce(content: string): string | null {
  const match = FENCE_BEGIN.exec(content);
  return match?.[1] ?? null;
}

/** Frontmatter's `updated:` line, blanked out, so two renders of the same content compare equal regardless of when either ran. */
export function withoutUpdatedTimestamp(text: string): string {
  return text.replace(/^updated: .*$/m, 'updated: ""');
}

/** Every distinct UTC calendar date any row in `rows` falls on — a message row or a reaction row alike. */
function affectedDates(rows: readonly RawMessageRow[]): string[] {
  const dates = new Set<string>();
  for (const row of rows) {
    const iso = appleEpochNsToIso(row.date_ns);
    if (iso !== null) dates.add(utcDateOf(iso));
  }
  return [...dates].sort();
}

/** The highest ROWID among rows this pass actually read, or `null` if there were none. */
function maxRowId(rows: readonly RawMessageRow[]): number | null {
  let max: number | null = null;
  for (const row of rows) {
    const value = Number(row.rowid);
    if (Number.isSafeInteger(value) && (max === null || value > max)) max = value;
  }
  return max;
}

/** Every attachment or reaction row can be ignored for the purposes of "does chat.db still have rows for this window at all". */
function hasAnyRow(rows: readonly RawMessageRow[]): boolean {
  return rows.length > 0;
}

async function upsertPart(
  deps: ImessageSyncDeps,
  part: ChannelDayPart,
): Promise<{ status: "written" | "unchanged" | "error"; message?: string }> {
  const existing = await deps.readNote(part.path);
  if (!existing.ok) return { status: "error", message: existing.message };

  const currentEtag = existing.found ? existing.etag : null;
  const currentContent = existing.found ? existing.content : null;

  if (currentContent !== null && withoutUpdatedTimestamp(currentContent) === withoutUpdatedTimestamp(part.text)) {
    return { status: "unchanged" };
  }

  const result = await deps.writeNote(part.path, part.text, currentEtag);
  if (result.ok) return { status: "written" };
  if (!result.conflict) return { status: "error", message: result.message };

  // One retry against whatever is actually there now — see the header on
  // conflict-safe writes (`CLAUDE.md`). There is no real second writer for a
  // personal machine's own iMessage history, so this exists for the case that
  // does happen: this same process syncing twice at once (a manual "sync now"
  // racing the timer), not a hostile one.
  const retryRead = await deps.readNote(part.path);
  if (!retryRead.ok) return { status: "error", message: retryRead.message };
  const retryContent = retryRead.found ? retryRead.content : null;
  if (retryContent !== null && withoutUpdatedTimestamp(retryContent) === withoutUpdatedTimestamp(part.text)) {
    return { status: "unchanged" };
  }
  const retryWrite = await deps.writeNote(part.path, part.text, retryRead.found ? retryRead.etag : null);
  if (retryWrite.ok) return { status: "written" };
  return { status: "error", message: retryWrite.message };
}

async function syncDay(
  deps: ImessageSyncDeps,
  date: string,
  participants: readonly RawParticipantRow[],
): Promise<DayOutcome> {
  const range = appleNsRangeForUtcDate(date);
  if (range === null) return { date, status: "error", parts: 0, message: `not a calendar date: ${date}` };
  const window: MessageWindow = { kind: "day", startNs: range.startNs, endNs: range.endNs };

  const [messages, attachments] = await Promise.all([
    deps.queryMessages(window),
    deps.queryAttachments(window),
  ]);

  const events: CommunicationEvent[] = readChatDbWindow(messages, attachments, participants, {
    selfAddresses: deps.selfAddresses,
  });

  if (events.length === 0) {
    // A day whose only rows were system messages, removed tapbacks, or
    // reactions with no target in range renders no note — see `reader.ts` —
    // and there is nothing here to upsert. Not an error: a day that never had
    // real content is not a day that failed to sync.
    return { date, status: "unchanged", parts: 0 };
  }

  // Reuse the nonce a previous run of this same day minted, so regenerating a
  // day that already exists does not rewrite every message's fence with a new
  // nonce — which would make "re-running changes no bytes" false on every day
  // that has ever been synced before. A day with no note yet gets a fresh one.
  const firstPartPath = channelDayNotePath({ channel: "imessage", date });
  const probe = await deps.readNote(firstPartPath);
  const nonce = (probe.ok && probe.found && existingNonce(probe.content)) || deps.mintNonce();

  const parts = planChannelDay(
    { channel: "imessage", date, events, nonce, now: deps.now(), origin: "desktop-imessage-sync" },
    {},
  );

  const outcomes = await Promise.all(parts.map((part) => upsertPart(deps, part)));
  const retired = await retireOrphanParts(deps, date, parts.length, nonce);
  const errored = [...outcomes, ...retired].find((outcome) => outcome.status === "error");
  if (errored) return { date, status: "error", parts: parts.length, message: errored.message };
  const status = [...outcomes, ...retired].some((outcome) => outcome.status === "written") ? "written" : "unchanged";
  return { date, status, parts: parts.length };
}

/**
 * Empty every part of a day past the last one it now renders into.
 *
 * A day splits into parts by rendered byte size, so a day that *loses*
 * messages — somebody deleted them in Messages.app — can render into fewer
 * parts than it did last time. Without this, `-part-3.md` would simply never
 * be re-rendered and would keep the deleted messages in the bucket forever,
 * which is the one outcome a person who deleted a message is entitled not to
 * get. Re-deriving a day from `chat.db` has to mean the *whole* day, and a
 * part nobody rewrites is not part of the day being re-derived.
 *
 * The note is **emptied, not deleted**: this app writes into somebody's own
 * bucket through `write_note` and does not remove their files. What it can
 * guarantee is that no message body survives in one, and an emptied part
 * renders as the same header with `messages: 0` and `_(no messages)_`.
 *
 * Parts are contiguous — part `n` is only ever written when parts `1..n-1`
 * were — so the scan stops at the first part that is not there, and a
 * `readNote` that *fails* stops it too rather than being read as "no more
 * parts": a transport error must not be the reason a stale part is left
 * standing, so it is reported as an error and holds the cursor back. It also
 * stops unconditionally after `MAX_ORPHAN_PARTS_SCANNED`; see that constant.
 */
async function retireOrphanParts(
  deps: ImessageSyncDeps,
  date: string,
  livingParts: number,
  nonce: string,
): Promise<Array<{ status: "written" | "unchanged" | "error"; message?: string }>> {
  const outcomes: Array<{ status: "written" | "unchanged" | "error"; message?: string }> = [];
  const ceiling = livingParts + MAX_ORPHAN_PARTS_SCANNED;
  for (let part = livingParts + 1; part <= ceiling; part += 1) {
    const path = channelDayNotePath({ channel: "imessage", date, part });
    const existing = await deps.readNote(path);
    if (!existing.ok) {
      outcomes.push({ status: "error", message: existing.message });
      return outcomes;
    }
    if (!existing.found) return outcomes;
    const text = renderChannelDayNote({
      channel: "imessage",
      date,
      events: [],
      part,
      parts: part,
      nonce,
      now: deps.now(),
      origin: "desktop-imessage-sync",
    });
    outcomes.push(await upsertPart(deps, { part, parts: part, events: [], path, text }));
  }
  return outcomes;
}

/** One incremental sync pass. See the header for the shape. */
export async function syncImessage(deps: ImessageSyncDeps, cursor: ImessageCursor): Promise<SyncReport> {
  const newRowsWindow: MessageWindow = { kind: "since", afterRowId: cursor.lastRowId };
  const newRows = await deps.queryMessages(newRowsWindow);

  if (!hasAnyRow(newRows)) {
    return { cursor, newRows: 0, days: [] };
  }

  const dates = affectedDates(newRows);
  const participants = await deps.queryParticipants();

  const days: DayOutcome[] = [];
  for (const date of dates) {
    // Sequential, deliberately: two days sharing a nonce lookup and a note
    // path prefix is exactly the kind of thing worth not racing against
    // itself, and a personal iMessage history's daily volume makes the
    // serial cost immaterial next to the network round trips it is already
    // paying.
    days.push(await syncDay(deps, date, participants));
  }

  const allClean = days.every((day) => day.status !== "error");
  const highest = maxRowId(newRows);
  const nextCursor = allClean && highest !== null ? advanceCursor(cursor, highest) : cursor;

  return { cursor: nextCursor, newRows: newRows.length, days };
}

/** Re-exported so a caller checking "was this row a message worth counting" does not need a second import. */
export { isReactionRow };
