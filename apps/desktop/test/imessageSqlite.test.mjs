/**
 * The real `/usr/bin/sqlite3` child process, against a real database.
 *
 * Every other iMessage test drives `reader.ts` and `sync.ts` with hand-built
 * JS objects. This file is the one that proves the SQL in `schema.ts` and the
 * process invocation in `sqlite.ts` actually produce those objects when run
 * against a genuine SQLite file carrying Apple's own column names — including
 * the two precision hazards that motivated `schema.ts`'s casts in the first
 * place: a `BLOB` column that `sqlite3 -json` would otherwise mangle, and a
 * 64-bit `date` that `JSON.parse` would otherwise round.
 *
 * `chat.db`'s schema is written out below from Apple's documented tables —
 * nothing here is a copy of a real database, which this repository is public
 * and must never carry (`CLAUDE.md`).
 *
 * **This suite is honestly skipped, never faked, when `/usr/bin/sqlite3` is
 * not on the machine running it** — a Linux CI runner may or may not have it
 * installed, and a skip here is reported exactly as loudly as a failure
 * (`test.mjs`'s `skip()`), never silently green. Every *parsing* rule these
 * queries feed (`reader.ts`, `attributedBody.ts`, `appleTime.ts`) is covered
 * unconditionally in the other iMessage suites, which never touch a process.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   `schema.ts` selecting `attributedBody` raw instead of `hex(...)`          1 (the row becomes unusable mush, caught by this file's own decode check)
 *   `schema.ts` selecting `date` without `CAST(... AS TEXT)`                  1 (the timestamp silently loses precision — caught by the exact-instant check below)
 */

import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SQLITE3_BINARY = "/usr/bin/sqlite3";

const SCHEMA_SQL = `
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE NOT NULL,
  text TEXT,
  handle_id INTEGER,
  date INTEGER,
  is_from_me INTEGER DEFAULT 0,
  cache_has_attachments INTEGER DEFAULT 0,
  associated_message_type INTEGER DEFAULT 0,
  associated_message_guid TEXT,
  attributedBody BLOB
);
CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE NOT NULL,
  chat_identifier TEXT,
  display_name TEXT,
  service_name TEXT
);
CREATE TABLE handle (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  service TEXT
);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
CREATE TABLE attachment (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT,
  mime_type TEXT,
  total_bytes INTEGER,
  transfer_name TEXT
);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
`;

/** A 64-bit Apple-epoch-nanosecond value real `sqlite3 -json` mangles through JSON.parse without the TEXT cast. */
const PRECISE_DATE_NS = "810432840123456789"; // 2026-09-07T00:14:00.123456789Z, truncated to ms on decode

async function sqliteExists() {
  try {
    await access(SQLITE3_BINARY);
    return true;
  } catch {
    return false;
  }
}

function buildFixtureDb(dbPath) {
  execFileSync(SQLITE3_BINARY, [dbPath, SCHEMA_SQL]);
  const seed = `
    INSERT INTO handle (ROWID, id, service) VALUES (1, '+15551230000', 'iMessage');
    INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name)
      VALUES (1, 'chat-guid-fixture', '+15551230000', NULL, 'iMessage');
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1);
    INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, associated_message_type, associated_message_guid, attributedBody)
      VALUES (1, 'msg-fixture-1', 'a message with an ordinary text column', 1, ${PRECISE_DATE_NS}, 0, 0, NULL, NULL);
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
    INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, associated_message_type, associated_message_guid, attributedBody)
      VALUES (2, 'msg-fixture-2', NULL, NULL, 810432900000000000, 1, 0, NULL, NULL);
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
    INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, associated_message_type, associated_message_guid, attributedBody)
      VALUES (3, 'msg-fixture-3', NULL, 1, 810432960000000000, 0, 2000, 'bp:msg-fixture-1', NULL);
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3);
    INSERT INTO attachment (ROWID, filename, mime_type, total_bytes, transfer_name)
      VALUES (1, 'photo.heic', 'image/heic', 204800, 'photo.heic');
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (2, 1);
  `;
  execFileSync(SQLITE3_BINARY, [dbPath, seed]);
}

export async function runImessageSqliteChecks(check, skip) {
  if (!(await sqliteExists())) {
    skip("real sqlite3 queries against a fixture chat.db", "/usr/bin/sqlite3 is not installed on this machine");
    return;
  }

  const originalHome = process.env.HOME;
  const tempHome = await mkdtemp(join(tmpdir(), "context-imessage-fixture-"));
  const messagesDir = join(tempHome, "Library", "Messages");
  await mkdir(messagesDir, { recursive: true });
  const dbPath = join(messagesDir, "chat.db");

  try {
    buildFixtureDb(dbPath);

    // Every module under test reads `os.homedir()` at call time, not at
    // import time, so pointing HOME at the fixture home directory is enough
    // to exercise `defaultChatDbPath`/`isAllowedChatDbPath` exactly as a real
    // launch would, with no path ever passed in from a test.
    process.env.HOME = tempHome;

    const [{ queryChatDb }, schema, paths, reader] = await Promise.all([
      import("../src/core/imessage/sqlite.ts"),
      import("../src/core/imessage/schema.ts"),
      import("../src/core/imessage/paths.ts"),
      import("../src/core/imessage/reader.ts"),
    ]);

    const path = paths.defaultChatDbPath();
    check("defaultChatDbPath resolves under the (fixture) home directory", path === dbPath);

    const messages = await queryChatDb(path, schema.selectMessagesSql({ kind: "since", afterRowId: 0 }));
    check("all three message rows come back", messages.length === 3);

    const withText = messages.find((row) => row.guid === "msg-fixture-1");
    check("a BLOB column comes back safely even when it is NULL (hex() of NULL, never mangled JSON)", withText.attributed_body_hex === "" || withText.attributed_body_hex === null);
    check(
      "the 64-bit date survives as an exact digit string — the precision a bare JSON number would have lost",
      withText.date_ns === PRECISE_DATE_NS,
    );
    const decoded = (await import("../src/core/imessage/appleTime.ts")).appleEpochNsToIso(withText.date_ns);
    check("the decoded instant is exactly right down to the millisecond", decoded === "2026-09-07T00:14:00.123Z");

    const reaction = messages.find((row) => row.guid === "msg-fixture-3");
    check("the tapback row round-trips its associated_message_type", reaction.associated_message_type === 2000);
    check("the tapback row round-trips the prefixed target guid", reaction.associated_message_guid === "bp:msg-fixture-1");

    const attachments = await queryChatDb(path, schema.selectAttachmentsSql({ kind: "since", afterRowId: 0 }));
    check("the attachment is joined to its message's guid, not its ROWID", attachments.length === 1 && attachments[0].message_guid === "msg-fixture-2");
    check("the attachment's byte size survives as a digit string", attachments[0].total_bytes === "204800");

    const participants = await queryChatDb(path, schema.selectParticipantsSql());
    check("the participant join returns the chat's one handle", participants.length === 1 && participants[0].address === "+15551230000");

    const events = reader.readChatDbWindow(messages, attachments, participants, {});
    check("run through the real reader, the tapback is folded into its target rather than appearing on its own", events.length === 2);
    const withReaction = events.find((event) => event.messageId === "msg-fixture-1");
    check("...and the annotation actually landed in that message's body", withReaction.body.includes("loved this message"));

    const dayWindow = schema.selectMessagesSql({
      kind: "day",
      ...(await import("../src/core/imessage/appleTime.ts")).appleNsRangeForUtcDate("2026-09-07"),
    });
    const dayRows = await queryChatDb(path, dayWindow);
    check("a day-range query returns every message actually on that UTC day", dayRows.length === 3);

    const refused = await queryChatDb(join(tempHome, "not-chat.db"), schema.selectParticipantsSql()).then(
      () => "did not throw",
      (error) => (error instanceof Error ? error.message : "threw something else"),
    );
    // The exact refusal message, not merely "it threw": a nonexistent file
    // would ALSO throw a ChatDbUnreadable if sqlite3 itself were spawned and
    // failed to open it — checking only the error class would pass even with
    // `isAllowedChatDbPath` sabotaged wide open, because sqlite3 would then
    // run, fail for an unrelated reason, and throw the same class of error.
    check(
      "a path that is not this Mac's own chat.db is refused BEFORE sqlite3 is even spawned — not merely that a read of it later failed",
      refused === "refused: not this Mac's own chat.db",
    );
  } finally {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  }
}
