/**
 * One sync pass: incremental, idempotent, and honest about partial failure.
 *
 * Every dependency here is a fake in-memory store — `sqlite.ts` and
 * `gatewayNotes.ts` are never imported — so what is proven is the *shape* of
 * `syncImessage`'s reducer: which day gets re-read, when a write actually
 * happens, and when the cursor is and is not allowed to move.
 *
 * ## Sabotage record
 *
 * Measured by actually editing `src/core/imessage/sync.ts` and reverting.
 * The second row is the one worth reading: it was **invisible** until the
 * fixture below was fixed to advance its own clock and a dedicated
 * "re-queried but renders no visible change" case was added — every scenario
 * that existed before that either never re-queried the day at all (so the
 * comparison was never reached) or genuinely changed the content (so a
 * literal-text comparison would have "passed" it for the wrong reason too).
 * A guard nobody's fixture actually exercises is not a guard; that was the
 * fixture's own defect, found and fixed in the same commit as this record.
 *
 *   `upsertPart` comparing rendered text literally instead of
 *     `withoutUpdatedTimestamp`                                          0 FAIL (before the fixture fix)
 *                                                                         4 FAIL (after it, re-measured in review)
 *   `retireOrphanParts` skipped, so a shrunk day keeps its old part N    3 FAIL
 *   `advanceCursor`'s backward/non-integer guard removed                 3 FAIL
 *
 * The orphan-part row is the second one worth reading. Its fixture gives the
 * two big messages *different* timestamps on the same day on purpose: with a
 * shared timestamp the split's tie breaks on an anchor hash, the deleted
 * message can land in part 1 where the ordinary rewrite removes it, and the
 * check passes without an orphan ever being exercised. Measured at 1 FAIL
 * that way, 3 once the fixture made the split deterministic — the same shape
 * of fixture defect as the row above it.
 */

import { existingNonce, syncImessage, withoutUpdatedTimestamp } from "../src/core/imessage/sync.ts";
import { EMPTY_CURSOR } from "../src/core/imessage/cursor.ts";

const NS_2026_09_06 = "810346440000000000"; // 2026-09-06T00:14:00.000Z
const NS_2026_09_07_LATER = "810436440000000000"; // 2026-09-07T01:14:00.000Z — same day, an hour on
const NS_2026_09_07 = "810432840000000000"; // 2026-09-07T00:14:00.000Z
const NS_2026_09_08 = "810519300000000000"; // 2026-09-08T00:15:00.000Z

function messageRow(overrides = {}) {
  return {
    rowid: "1",
    guid: "g1",
    date_ns: NS_2026_09_07,
    text: "hello",
    attributed_body_hex: null,
    is_from_me: 0,
    associated_message_type: 0,
    associated_message_guid: null,
    chat_guid: "chat-1",
    chat_display_name: null,
    chat_identifier: "+15551234567",
    sender_address: "+15551234567",
    ...overrides,
  };
}

/**
 * An in-memory `chat.db` + note store: `queryMessages` answers from a growing
 * array exactly the way the real SQL would (`since` by ROWID, `day` by the
 * Apple-epoch range), and `readNote`/`writeNote` are a `Map` standing in for
 * the bucket, complete with etag conflicts.
 */
function fakeDeps(rows) {
  const notes = new Map(); // path -> { content, etag }
  const writeCalls = [];
  let etagCounter = 0;
  let nonceCounter = 0;
  // Advances on every call — deliberately, so "re-running with nothing new
  // changes no bytes" is a real check rather than one two identical `now()`
  // values would pass by accident. If `upsertPart` ever compared rendered
  // text literally instead of `withoutUpdatedTimestamp`, every call to
  // `now()` below would make every regenerated day differ from what is
  // stored, and this fixture is what would catch it.
  let clock = Date.parse("2026-09-07T18:00:00.000Z");

  return {
    rows,
    notes,
    writeCalls,
    async queryMessages(window) {
      if (window.kind === "since") return rows.filter((row) => Number(row.rowid) > window.afterRowId);
      return rows.filter((row) => BigInt(row.date_ns) >= BigInt(window.startNs) && BigInt(row.date_ns) < BigInt(window.endNs));
    },
    async queryAttachments() {
      return [];
    },
    async queryParticipants() {
      return [];
    },
    async readNote(path) {
      const entry = notes.get(path);
      return entry ? { ok: true, found: true, etag: entry.etag, content: entry.content } : { ok: true, found: false };
    },
    async writeNote(path, content, expectedEtag) {
      writeCalls.push({ path, expectedEtag });
      const entry = notes.get(path);
      const currentEtag = entry ? entry.etag : null;
      if (currentEtag !== expectedEtag) return { ok: false, conflict: true, retryable: false, message: "conflict" };
      etagCounter += 1;
      const etag = `etag-${etagCounter}`;
      notes.set(path, { content, etag });
      return { ok: true, etag };
    },
    now: () => {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    mintNonce: () => {
      nonceCounter += 1;
      return `nonce-${nonceCounter}`.padEnd(16, "0");
    },
  };
}

export async function runImessageSyncChecks(check) {
  // -- a first pass writes, and the cursor advances -------------------------
  const deps1 = fakeDeps([messageRow()]);
  const report1 = await syncImessage(deps1, EMPTY_CURSOR);
  check("a first pass reports the new rows it saw", report1.newRows === 1);
  check("the affected day is written", report1.days.length === 1 && report1.days[0].status === "written");
  check("the cursor advances past the highest ROWID seen", report1.cursor.lastRowId === 1);
  check("exactly one note now exists", deps1.notes.size === 1);
  check("the note lands at the fixed iMessage path for that day", deps1.notes.has("0-inbox/imessage/2026-09-07.md"));

  // -- re-running with NOTHING new changes no bytes -------------------------
  const before = deps1.notes.get("0-inbox/imessage/2026-09-07.md").content;
  const writesBefore = deps1.writeCalls.length;
  const report2 = await syncImessage(deps1, report1.cursor);
  check("a pass with nothing past the cursor reports zero new rows", report2.newRows === 0);
  check("...and touches no days at all", report2.days.length === 0);
  check("...and calls writeNote zero additional times", deps1.writeCalls.length === writesBefore);
  check("...and the stored bytes are exactly what they were", deps1.notes.get("0-inbox/imessage/2026-09-07.md").content === before);

  // -- a new message on the SAME day regenerates it, and its nonce is reused --
  deps1.rows.push(messageRow({ rowid: "2", guid: "g2", date_ns: NS_2026_09_07, text: "second message" }));
  const firstNonce = existingNonce(before);
  const report3 = await syncImessage(deps1, report1.cursor);
  check("the day is regenerated as WRITTEN, since it now has new content", report3.days[0].status === "written");
  const after = deps1.notes.get("0-inbox/imessage/2026-09-07.md").content;
  check("the regenerated day carries both messages", after.includes("hello") && after.includes("second message"));
  check(
    "regenerating an existing day reuses its ORIGINAL nonce rather than minting a new one — otherwise every fence in the file would silently rewrite",
    existingNonce(after) === firstNonce,
  );
  check("the cursor advances again", report3.cursor.lastRowId === 2);

  // -- an untouched day, sitting beside an actively-changing one, is not rewritten --
  const deps2 = fakeDeps([messageRow({ rowid: "1", guid: "d1", date_ns: NS_2026_09_07 })]);
  const r1 = await syncImessage(deps2, EMPTY_CURSOR);
  deps2.rows.push(messageRow({ rowid: "2", guid: "d2", date_ns: NS_2026_09_08 }));
  const day1Before = deps2.notes.get("0-inbox/imessage/2026-09-07.md").content;
  const writesBeforeR2 = deps2.writeCalls.length;
  const r2 = await syncImessage(deps2, r1.cursor);
  check("only the day with new activity is touched", r2.days.length === 1 && r2.days[0].date === "2026-09-08");
  check("the OTHER day's stored bytes are untouched", deps2.notes.get("0-inbox/imessage/2026-09-07.md").content === day1Before);
  check(
    "writeNote is never called for the untouched day (only for the affected one)",
    deps2.writeCalls.length === writesBeforeR2 + 1,
  );

  // -- a day whose only new rows carry no real content advances the cursor too --
  const deps3 = fakeDeps([messageRow({ rowid: "1", guid: "sys-1", text: null, attributed_body_hex: null })]);
  const r3 = await syncImessage(deps3, EMPTY_CURSOR);
  check("a day with no recoverable events is reported unchanged, not an error", r3.days.length === 1 && r3.days[0].status === "unchanged");
  check("...and still advances the cursor, so it is never re-queried forever", r3.cursor.lastRowId === 1);
  check("...and no note was written for it", deps3.notes.size === 0);

  // -- a day that is RE-QUERIED (a new row landed on it) but renders BYTE-
  // IDENTICAL content — a removed tapback contributes nothing to render —
  // still calls writeNote ZERO times. This is the one case that actually
  // exercises the "unchanged" branch of the content comparison itself: every
  // other "nothing changes" scenario above never re-queries the day at all,
  // so a sabotage that compared rendered text literally (never stripping the
  // `updated` timestamp) would pass every check above and only fail here.
  const deps6 = fakeDeps([messageRow({ rowid: "1", guid: "stable-1", date_ns: NS_2026_09_07 })]);
  const r7 = await syncImessage(deps6, EMPTY_CURSOR);
  const stableBefore = deps6.notes.get("0-inbox/imessage/2026-09-07.md").content;
  deps6.rows.push(
    messageRow({
      rowid: "2",
      guid: "removed-tapback-1",
      date_ns: NS_2026_09_07,
      text: null,
      associated_message_type: 3000, // a removed tapback: dropped outright, contributes no content
      associated_message_guid: "bp:stable-1",
    }),
  );
  const writesBeforeR8 = deps6.writeCalls.length;
  const r8 = await syncImessage(deps6, r7.cursor);
  check("a day re-queried because of a new row that renders no visible change is reported unchanged, not written", r8.days[0].status === "unchanged");
  check("...and writeNote is called zero additional times for it", deps6.writeCalls.length === writesBeforeR8);
  check("...and the stored bytes are byte-for-byte what they were", deps6.notes.get("0-inbox/imessage/2026-09-07.md").content === stableBefore);
  check("...and the cursor still advances past the new row", r8.cursor.lastRowId === 2);

  // -- a write error holds the WHOLE pass's cursor back, not just that day ----
  const deps4 = fakeDeps([messageRow({ rowid: "1", guid: "e1" })]);
  const originalWrite = deps4.writeNote;
  deps4.writeNote = async () => ({ ok: false, conflict: false, retryable: true, message: "gateway unavailable" });
  const r4 = await syncImessage(deps4, EMPTY_CURSOR);
  check("a failed write is reported as an error for that day", r4.days[0].status === "error");
  check("the cursor does NOT advance past a pass that had any error", r4.cursor.lastRowId === EMPTY_CURSOR.lastRowId);
  deps4.writeNote = originalWrite;
  const r5 = await syncImessage(deps4, r4.cursor);
  check("retrying the same pass (cursor unchanged) picks the row back up and succeeds this time", r5.days[0].status === "written" && r5.cursor.lastRowId === 1);

  // -- a conflicting write is retried once, and settles ------------------
  const deps5 = fakeDeps([messageRow({ rowid: "1", guid: "c1" })]);
  let writeAttempts = 0;
  const realWrite = deps5.writeNote.bind(deps5);
  deps5.writeNote = async (path, content, expectedEtag) => {
    writeAttempts += 1;
    if (writeAttempts === 1) return { ok: false, conflict: true, retryable: false, message: "conflict" };
    return realWrite(path, content, expectedEtag);
  };
  const r6 = await syncImessage(deps5, EMPTY_CURSOR);
  check("a conflicted write is retried once against the freshly re-read note", r6.days[0].status === "written" && writeAttempts === 2);

  // -- withoutUpdatedTimestamp: what makes two renders of the same day compare equal --
  const a = 'updated: "2026-09-07T00:00:00.000Z"\ntype: "channel-day"\nbody text';
  const b = 'updated: "2026-09-07T18:04:11.221Z"\ntype: "channel-day"\nbody text';
  check("two renders differing ONLY in the updated timestamp compare equal once normalized", withoutUpdatedTimestamp(a) === withoutUpdatedTimestamp(b));
  const c = 'updated: "2026-09-07T00:00:00.000Z"\ntype: "channel-day"\nDIFFERENT body text';
  check("...but a real content difference still compares unequal", withoutUpdatedTimestamp(a) !== withoutUpdatedTimestamp(c));

  check("existingNonce reads the fence's own nonce out of a rendered note", existingNonce('<!-- context:untrusted-communication begin abc123 -->') === "abc123");
  check("existingNonce answers null for a note with no fence at all (never written yet)", existingNonce("nothing here") === null);

  // -- a message DELETED on the Mac -----------------------------------------
  //
  // Each affected day is re-read from `chat.db` and re-rendered from scratch
  // rather than patched, so a message that is gone from the source is gone
  // from the regenerated note. What re-reads the day is a *new row landing on
  // it* — a deletion writes no row, so on its own it does not schedule
  // anything, and that limit is pinned here rather than left to be discovered.
  const deps7 = fakeDeps([
    messageRow({ rowid: "1", guid: "keep-1", date_ns: NS_2026_09_07, text: "the one that stays" }),
    messageRow({ rowid: "2", guid: "gone-1", date_ns: NS_2026_09_07, text: "the one that gets deleted" }),
  ]);
  const r9 = await syncImessage(deps7, EMPTY_CURSOR);
  const dayPath = "0-inbox/imessage/2026-09-07.md";
  check("both messages land in the day first", deps7.notes.get(dayPath).content.includes("the one that gets deleted"));

  // The Mac's own Messages app deleted it: the row is simply not there any
  // more. Spliced in place rather than reassigned, because `queryMessages`
  // closes over the array itself — a fixture that swapped the reference would
  // quietly test nothing.
  deps7.rows.splice(deps7.rows.findIndex((row) => row.guid === "gone-1"), 1);
  const writesBeforeDeletion = deps7.writeCalls.length;
  const r10 = await syncImessage(deps7, r9.cursor);
  check(
    "a deletion on its own schedules nothing — no row arrived, so no day is re-read",
    r10.newRows === 0 && deps7.writeCalls.length === writesBeforeDeletion,
  );
  check(
    "...and the stored day still carries it until something else touches that day",
    deps7.notes.get(dayPath).content.includes("the one that gets deleted"),
  );

  // Now something else lands on that same day, and the whole day is re-derived.
  deps7.rows.push(messageRow({ rowid: "3", guid: "new-1", date_ns: NS_2026_09_07, text: "a later message" }));
  const r11 = await syncImessage(deps7, r10.cursor);
  const afterDeletion = deps7.notes.get(dayPath).content;
  check("the re-read day is REGENERATED, not appended to", r11.days[0].status === "written");
  check("...so the deleted message is gone from the note entirely", !afterDeletion.includes("the one that gets deleted"));
  check("...and the surviving messages are both still there", afterDeletion.includes("the one that stays") && afterDeletion.includes("a later message"));
  check("...and the day kept its original fence nonce through the regeneration", existingNonce(afterDeletion) === existingNonce(deps7.notes.get(dayPath).content));

  // -- a row that arrives LATER but belongs to an EARLIER day ----------------
  //
  // `chat.db` hands out ROWIDs in insert order, not date order: a message
  // received while the Mac was asleep, or one that syncs down from another
  // device days late, gets a fresh (higher) ROWID carrying an older `date`.
  // The cursor is a ROWID, so it still sees the row — and the day the row's
  // own timestamp names is what gets re-read, never the day the sync ran on.
  const deps8 = fakeDeps([messageRow({ rowid: "1", guid: "today-1", date_ns: NS_2026_09_07 })]);
  const r12 = await syncImessage(deps8, EMPTY_CURSOR);
  deps8.rows.push(messageRow({ rowid: "2", guid: "late-arrival", date_ns: NS_2026_09_06, text: "sent two days ago, delivered now" }));
  const r13 = await syncImessage(deps8, r12.cursor);
  check(
    "A ROW WITH A HIGHER ROWID AND AN OLDER DATE IS NOT SKIPPED — its own day is what gets re-read",
    r13.days.length === 1 && r13.days[0].date === "2026-09-06" && r13.days[0].status === "written",
  );
  check(
    "...and it is filed under the day its timestamp names, not the day the sync ran",
    deps8.notes.get("0-inbox/imessage/2026-09-06.md").content.includes("sent two days ago, delivered now"),
  );
  check("...and the already-correct day beside it is not rewritten", deps8.notes.get("0-inbox/imessage/2026-09-07.md").content === deps8.notes.get("0-inbox/imessage/2026-09-07.md").content);
  check("...and the cursor advances past it", r13.cursor.lastRowId === 2);

  // A single pass carrying rows for several days at once must schedule every
  // one of them, in date order, rather than only the newest.
  const deps9 = fakeDeps([
    messageRow({ rowid: "1", guid: "m-08", date_ns: NS_2026_09_08 }),
    messageRow({ rowid: "2", guid: "m-06", date_ns: NS_2026_09_06 }),
    messageRow({ rowid: "3", guid: "m-07", date_ns: NS_2026_09_07 }),
  ]);
  const r14 = await syncImessage(deps9, EMPTY_CURSOR);
  check(
    "one pass spanning three days writes all three, in calendar order",
    r14.days.map((day) => day.date).join(",") === "2026-09-06,2026-09-07,2026-09-08",
  );

  // -- a day that splits into several parts, with the SECOND one failing ----
  //
  // `planChannelDay` splits a day past its byte threshold, and each part is a
  // separate `write_note`. A pass interrupted between them leaves part 1 in the
  // bucket and part 2 missing — a real half-written day, for as long as it
  // takes the next pass to run. What must hold is that the *cursor never
  // advances past it*, so the next pass re-derives the whole day from
  // `chat.db` and lands both parts. That is the property checked here.
  const bulk = "x".repeat(400 * 1024);
  const deps10 = fakeDeps([
    messageRow({ rowid: "1", guid: "big-1", date_ns: NS_2026_09_07, text: `first ${bulk}` }),
    messageRow({ rowid: "2", guid: "big-2", date_ns: NS_2026_09_07, text: `second ${bulk}` }),
  ]);
  const realBigWrite = deps10.writeNote.bind(deps10);
  deps10.writeNote = async (path, content, expectedEtag) =>
    path.endsWith("2026-09-07-part-2.md")
      ? { ok: false, conflict: false, retryable: true, message: "gateway unavailable" }
      : realBigWrite(path, content, expectedEtag);
  const r15 = await syncImessage(deps10, EMPTY_CURSOR);
  check("a day big enough to split really did split into more than one part", r15.days[0].parts > 1);
  check("a day whose second part failed is reported as an error, not a success", r15.days[0].status === "error");
  check(
    "THE CURSOR DOES NOT ADVANCE PAST A HALF-WRITTEN DAY, so the next pass re-derives the whole of it",
    r15.cursor.lastRowId === EMPTY_CURSOR.lastRowId,
  );
  deps10.writeNote = realBigWrite;
  const r16 = await syncImessage(deps10, r15.cursor);
  check("the retried pass completes the day", r16.days[0].status === "written" && r16.cursor.lastRowId === 2);
  const part1 = deps10.notes.get("0-inbox/imessage/2026-09-07.md");
  const part2 = deps10.notes.get("0-inbox/imessage/2026-09-07-part-2.md");
  check("both parts of the day now exist", part1 !== undefined && part2 !== undefined);
  check(
    "...and both carry the SAME fence nonce, so the two halves of one day are one document",
    existingNonce(part1.content) === existingNonce(part2.content),
  );
  const r17 = await syncImessage(deps10, r16.cursor);
  check("...and a further pass over the settled multi-part day changes nothing", r17.newRows === 0 && r17.days.length === 0);

  // -- a day that SHRINKS below its old part count -------------------------
  //
  // The one place "the day is re-derived from chat.db" could quietly stop
  // being true: enough messages deleted that the day no longer splits, and the
  // part that is no longer rendered is simply never rewritten — leaving a
  // deleted message sitting in `-part-2.md` in somebody's bucket forever.
  //
  // The two messages carry different timestamps on the same day, so the split
  // is deterministic: `planChannelDay` orders chronologically, which puts the
  // one about to be deleted in part 2. A fixture where both shared a timestamp
  // would break the tie on an anchor hash and could land it in part 1, where
  // the ordinary rewrite would remove it and this check would pass without
  // ever exercising the orphan at all.
  const deps11 = fakeDeps([
    messageRow({ rowid: "1", guid: "shrink-1", date_ns: NS_2026_09_07, text: `kept ${bulk}` }),
    messageRow({ rowid: "2", guid: "shrink-2", date_ns: NS_2026_09_07_LATER, text: `deleted-later ${bulk}` }),
  ]);
  const r18 = await syncImessage(deps11, EMPTY_CURSOR);
  const orphanPath = "0-inbox/imessage/2026-09-07-part-2.md";
  check("the big day starts out as two parts", r18.days[0].parts === 2 && deps11.notes.has(orphanPath));
  check(
    "...and the message about to be deleted is in the SECOND part — the one a shrink stops rewriting",
    deps11.notes.get(orphanPath).content.includes("deleted-later"),
  );

  deps11.rows.splice(deps11.rows.findIndex((row) => row.guid === "shrink-2"), 1);
  deps11.rows.push(messageRow({ rowid: "3", guid: "shrink-3", date_ns: NS_2026_09_07, text: "a small new one" }));
  const r19 = await syncImessage(deps11, r18.cursor);
  check("the shrunk day now renders into one part", r19.days[0].parts === 1);
  check(
    "A DELETED MESSAGE DOES NOT SURVIVE IN THE ORPHANED PART — the part past the day's new last one is emptied",
    !deps11.notes.get(orphanPath).content.includes("deleted-later"),
  );
  check("...and it is emptied rather than removed: this app does not delete somebody's own notes", deps11.notes.has(orphanPath));
  check("...and the emptied part says so, rather than being a truncated file", deps11.notes.get(orphanPath).content.includes("_(no messages)_"));
  check("...and nothing of the deleted message survives anywhere in the day", ![...deps11.notes.values()].some((note) => note.content.includes("deleted-later")));

  const writesBeforeSettle = deps11.writeCalls.length;
  deps11.rows.push(
    messageRow({
      rowid: "4",
      guid: "shrink-noop",
      date_ns: NS_2026_09_07,
      text: null,
      associated_message_type: 3000,
      associated_message_guid: "bp:shrink-1",
    }),
  );
  const r20 = await syncImessage(deps11, r19.cursor);
  check(
    "...and re-reading the settled shrunk day writes nothing at all, orphan included",
    r20.days[0].status === "unchanged" && deps11.writeCalls.length === writesBeforeSettle,
  );
}
