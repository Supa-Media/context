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
 *   `exec.ts`'s `run` rejecting with the underlying error rather than
 *     `${command} failed`                                                    3 (the sqlite3 error text carries the failing query straight into a
 *                                                                               `ChatDbUnreadable` message — caught by the redaction checks below)
 */

import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
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

/**
 * The bytes a hostile sender gets to choose, in every column that carries any:
 * a handle, a group's name, a message body and an attachment's filename.
 *
 * Shell metacharacters, SQL string terminators, command substitution in both
 * spellings, and a newline — the four things that would matter if any of these
 * values were ever concatenated into a command line or into SQL text. Nothing
 * in this app builds either from a column, and this fixture is what says so
 * rather than the comment that claims it.
 */
const HOSTILE = Object.freeze({
  handle: "+1555'; DROP TABLE message; --",
  groupName: "Trip $(touch OWNED-BY-GROUP-NAME) `touch OWNED-BY-BACKTICK` ; rm -rf .",
  body: "line one\nline two \"quoted\" 'single' $(touch OWNED-BY-BODY) `touch OWNED-BY-BODY2` | tee /dev/null",
  filename: "photo'; DROP TABLE attachment; --$(touch OWNED-BY-FILENAME).heic",
});

/** A SQL string literal — the one way this test file itself gets hostile bytes into the fixture. */
function sqlLiteral(value) {
  return `'${String(value).split("'").join("''")}'`;
}

function seedHostileRows(dbPath) {
  const seed = `
    INSERT INTO handle (ROWID, id, service) VALUES (2, ${sqlLiteral(HOSTILE.handle)}, 'iMessage');
    INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name)
      VALUES (2, 'chat-guid-hostile', 'chat9999', ${sqlLiteral(HOSTILE.groupName)}, 'iMessage');
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 2);
    INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, associated_message_type, associated_message_guid, attributedBody)
      VALUES (10, 'msg-hostile-1', ${sqlLiteral(HOSTILE.body)}, 2, 810433020000000000, 0, 0, NULL, NULL);
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 10);
    INSERT INTO attachment (ROWID, filename, mime_type, total_bytes, transfer_name)
      VALUES (2, ${sqlLiteral(HOSTILE.filename)}, 'image/heic', 512, 'x.heic');
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (10, 2);
  `;
  execFileSync(SQLITE3_BINARY, [dbPath, seed]);
}

/** Everything in a directory, and the sha256 of one file in it — the facts a read must not change. */
async function fingerprint(dir, file) {
  const entries = (await readdir(dir)).sort();
  const bytes = await readFile(file);
  const info = await stat(file);
  return {
    entries: entries.join(","),
    digest: createHash("sha256").update(bytes).digest("hex"),
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
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

    // A path outside `~/Library/Messages` that IS a perfectly good SQLite
    // database — the case the refusal actually has to hold for, since a
    // nonexistent file would have failed anyway.
    const decoyDb = join(tempHome, "decoy.db");
    execFileSync(SQLITE3_BINARY, [
      decoyDb,
      "CREATE TABLE handle (ROWID INTEGER, id TEXT); INSERT INTO handle VALUES (1, 'decoy');",
    ]);
    const decoyOutcome = await queryChatDb(decoyDb, schema.selectParticipantsSql()).then(
      (rows) => `read ${rows.length} rows`,
      (error) => error.message,
    );
    check(
      "A READABLE SQLITE DATABASE OUTSIDE ~/Library/Messages IS STILL REFUSED — the guard is the path, not whether the file happens to open",
      decoyOutcome === "refused: not this Mac's own chat.db",
    );
    const traversal = join(messagesDir, "..", "..", "decoy.db");
    const traversalOutcome = await queryChatDb(traversal, schema.selectParticipantsSql()).then(
      () => "read",
      (error) => error.message,
    );
    check(
      "...and so is one reached by traversing out of the Messages folder and back down",
      traversalOutcome === "refused: not this Mac's own chat.db",
    );
    check(
      "...while the one allowed file reached THROUGH a `..` still resolves to itself",
      paths.isAllowedChatDbPath(join(messagesDir, "..", "Messages", "chat.db")),
    );

    // -- the read never writes, and never copies ---------------------------
    //
    // `-readonly` and `?mode=ro` are two claims in a comment until something
    // measures them. The digest, the size, the mtime and the whole directory
    // listing are taken either side of a full read cycle: a rollback journal,
    // a `-wal`, a `-shm`, a temp copy or a single changed byte all show here.
    const beforeRead = await fingerprint(messagesDir, dbPath);
    const homeBefore = (await readdir(tempHome)).sort().join(",");
    await queryChatDb(dbPath, schema.selectMessagesSql({ kind: "since", afterRowId: 0 }));
    await queryChatDb(dbPath, schema.selectAttachmentsSql({ kind: "since", afterRowId: 0 }));
    await queryChatDb(dbPath, schema.selectParticipantsSql());
    await queryChatDb(dbPath, schema.selectMaxRowIdSql());
    const afterRead = await fingerprint(messagesDir, dbPath);
    check(
      "THE DATABASE'S BYTES ARE UNCHANGED by a full read cycle",
      beforeRead.digest === afterRead.digest && beforeRead.size === afterRead.size,
    );
    check(
      "...and its modification time is untouched, so nothing ever opened it for writing",
      beforeRead.mtimeMs === afterRead.mtimeMs,
    );
    check(
      "...and no journal, -wal, -shm or temp copy was left beside it",
      beforeRead.entries === afterRead.entries && afterRead.entries === "chat.db",
    );
    check(
      "...and nothing was copied anywhere else under the home directory either",
      homeBefore === (await readdir(tempHome)).sort().join(","),
    );

    // -- a sender's own bytes, through every column that carries any -------
    //
    // Nothing here is spliced into a command line (`exec.ts` runs `execFile`
    // with `shell: false` and an argv array) or into SQL text (`schema.ts`
    // interpolates validated digit strings and nothing else). This measures
    // both at once: the values survive verbatim, the tables they tried to drop
    // are still there, and none of the four `touch` commands ran.
    seedHostileRows(dbPath);
    const hostileMessages = await queryChatDb(dbPath, schema.selectMessagesSql({ kind: "since", afterRowId: 9 }));
    const hostileAttachments = await queryChatDb(dbPath, schema.selectAttachmentsSql({ kind: "since", afterRowId: 9 }));
    const hostileParticipants = await queryChatDb(dbPath, schema.selectParticipantsSql());
    const hostileRow = hostileMessages.find((row) => row.guid === "msg-hostile-1");
    check("a message body full of shell metacharacters comes back byte-for-byte", hostileRow?.text === HOSTILE.body);
    check(
      "a group display name containing $( ), backticks and a semicolon comes back byte-for-byte",
      hostileRow?.chat_display_name === HOSTILE.groupName,
    );
    check("a handle carrying a SQL string terminator comes back byte-for-byte", hostileRow?.sender_address === HOSTILE.handle);
    check(
      "an attachment filename carrying the same comes back byte-for-byte",
      hostileAttachments.some((row) => row.filename === HOSTILE.filename),
    );
    const survivingMessages = await queryChatDb(dbPath, schema.selectMessagesSql({ kind: "since", afterRowId: 0 }));
    const survivingAttachments = await queryChatDb(dbPath, schema.selectAttachmentsSql({ kind: "since", afterRowId: 0 }));
    check(
      "the tables those values tried to drop are all still there, with every row",
      survivingMessages.length === 4 && survivingAttachments.length === 2,
    );
    const spawned = [...(await readdir(tempHome)), ...(await readdir(messagesDir)), ...(await readdir(process.cwd()))];
    check(
      "NOT ONE OF THE FOUR COMMAND-SUBSTITUTION PAYLOADS RAN — there is no shell anywhere on this path",
      !spawned.some((name) => name.startsWith("OWNED-BY-")),
    );
    const hostileEvents = reader.readChatDbWindow(hostileMessages, hostileAttachments, hostileParticipants, {});
    check(
      "...and the hostile row still becomes an ordinary event, carrying its own bytes",
      hostileEvents.length === 1 && hostileEvents[0].body === HOSTILE.body && hostileEvents[0].subject === HOSTILE.groupName,
    );

    // -- a failing query says nothing about what it was asked -------------
    //
    // `run` replaces the underlying error with `${command} failed`, and the
    // whole reason it does is that a `sqlite3` failure message echoes the
    // failing statement — which here is a query over a database of somebody's
    // messages. `queryChatDb` passes that message straight into a
    // `ChatDbUnreadable`, so this is where the redaction is load-bearing
    // rather than where it is merely written down.
    const failure = await queryChatDb(dbPath, "SELECT no_such_column FROM message WHERE text LIKE '%needle%';").then(
      () => "did not throw",
      (error) => error.message,
    );
    check("a failing query throws a fixed sentence naming only the binary", failure === "/usr/bin/sqlite3 failed");
    check(
      "...which carries no fragment of the SQL it was asked to run",
      !failure.includes("no_such_column") && !failure.includes("needle"),
    );
    check("...and no fragment of the database path either", !failure.includes(dbPath) && !failure.includes("Messages"));

    // -- the ROWID cursor cannot skip a row -------------------------------
    //
    // The whole incremental design rests on one property of Apple's schema:
    // `message.ROWID` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so a ROWID is
    // never reused. Were it reused, removing the newest message and receiving
    // a new one would hand that new message a ROWID at or below the stored
    // cursor, and it would never be read again. Measured against the real
    // engine rather than assumed from the schema text.
    const highestBefore = (await queryChatDb(dbPath, schema.selectMaxRowIdSql()))[0].rowid;
    execFileSync(SQLITE3_BINARY, [dbPath, `DELETE FROM message WHERE ROWID = ${highestBefore};`]);
    execFileSync(SQLITE3_BINARY, [
      dbPath,
      "INSERT INTO message (guid, text, handle_id, date, is_from_me) VALUES ('msg-after-delete', 'arrived later', 1, 810433080000000000, 0);",
    ]);
    const highestAfter = (await queryChatDb(dbPath, schema.selectMaxRowIdSql()))[0].rowid;
    check(
      "A ROWID IS NEVER REUSED after the highest row is removed — the cursor cannot skip the message that replaces it",
      Number(highestAfter) > Number(highestBefore),
    );
  } finally {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  }
}
