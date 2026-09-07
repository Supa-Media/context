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
 *                                                                         3 FAIL (after it)
 */

import { existingNonce, syncImessage, withoutUpdatedTimestamp } from "../src/core/imessage/sync.ts";
import { EMPTY_CURSOR } from "../src/core/imessage/cursor.ts";

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
}
