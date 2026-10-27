/**
 * The Messages backup's SQL against real SQLite files, and the service end to
 * end over them: a fixture `chat.db` (one with Apple's newer columns, one
 * without), a fixture Contacts database, and a fake gateway.
 *
 * Every table and value below is written out by hand from the column names
 * Apple's databases use; nothing here is a copy of a real one (`CLAUDE.md`).
 *
 * Honestly skipped, never faked, when `/usr/bin/sqlite3` is missing, as
 * `imessageSqlite.test.mjs` is.
 *
 * ## Sabotage record
 *
 *   queries.ts naming date_edited on a database without it      1 (the old-schema read throws, ending the suite)
 *   queries.ts dropping the NULLIF on date_retracted            2 (every message reads as unsent)
 *   messagesBackup.ts sending before Full Disk Access           1
 *   queries.ts reading an unsent message's files                4
 *   readAttachment not following links before the check        1
 */

import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile, symlink } from "node:fs/promises";

const SQLITE3 = "/usr/bin/sqlite3";

const MESSAGE_COLUMNS_OLD = `
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER, date INTEGER,
  is_from_me INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0, associated_message_guid TEXT, attributedBody BLOB`;
const MESSAGE_COLUMNS_NEW = `${MESSAGE_COLUMNS_OLD},
  date_edited INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0, thread_originator_guid TEXT, service TEXT`;

function schema(messageColumns) {
  return `
CREATE TABLE message (${messageColumns});
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, chat_identifier TEXT, display_name TEXT, service_name TEXT, account_login TEXT);
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, service TEXT);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, filename TEXT, mime_type TEXT, total_bytes INTEGER, transfer_name TEXT);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);`;
}

const T = (minutes) => String(814295520000000000n + BigInt(minutes) * 60_000_000_000n); // from 2026-10-21T17:12:00Z

function seed(newColumns) {
  const extra = (edited, retracted, service) => (newColumns ? `, ${edited}, ${retracted}, NULL, '${service}'` : "");
  const cols = newColumns ? ", date_edited, date_retracted, thread_originator_guid, service" : "";
  const message = (id, guid, text, handle, minutes, me, type = 0, target = "NULL", edited = 0, retracted = 0, chat = 1) => `
    INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, associated_message_type, associated_message_guid, attributedBody${cols})
      VALUES (${id}, '${guid}', ${text === null ? "NULL" : `'${text}'`}, ${handle}, ${T(minutes)}, ${me}, ${type}, ${target}, NULL${extra(edited, retracted, "iMessage")});
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (${chat}, ${id});`;
  return `
    INSERT INTO handle (ROWID, id, service) VALUES (1, '+15550100100', 'iMessage'), (2, '+15550100200', 'iMessage');
    INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name, account_login) VALUES
      (1, 'iMessage;-;+15550100100', '+15550100100', NULL, 'iMessage', 'P:+15550104410'),
      (2, 'iMessage;+;chat-family', 'chat-family', 'Okafor family', 'iMessage', 'P:+15550104410');
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1), (2, 1), (2, 2);
    ${message(1, "G1", "Dinner at 4. Bring the rice?", 1, 0, 0)}
    ${message(2, "G2", "Yes", "NULL", 1, 1)}
    ${message(3, "G3", null, 1, 2, 0, 2000, "'p:0/G2'")}
    ${message(4, "G4", "Dinner at 5 actually", 1, 3, 0, 0, "NULL", newColumns ? T(10) : 0)}
    ${message(5, "G5", "", 2, 4, 0, 0, "NULL", 0, newColumns ? T(11) : 0, 2)}
    ${message(6, "G6", "photo", 2, 5, 0, 0, "NULL", 0, 0, 2)}
    INSERT INTO attachment (ROWID, guid, filename, mime_type, total_bytes, transfer_name) VALUES
      (1, 'AT-1', '~/Library/Messages/Attachments/aa/01/IMG_0001.HEIC', 'image/heic', 13, 'IMG_0001.HEIC'),
      (2, 'AT-2', '~/Library/Messages/Attachments/aa/02/clip.MOV', 'video/quicktime', 40, 'clip.MOV'),
      (3, 'AT-3', '~/Library/Messages/Attachments/aa/03/gone.pdf', 'application/pdf', 10, 'gone.pdf'),
      (4, 'AT-4', '~/Library/Messages/../Messages/chat.db', 'image/png', 10, 'sneaky.png'),
      (5, 'AT-5', '~/Library/Messages/Attachments/aa/05/taken-back.jpg', 'image/jpeg', 10, 'taken-back.jpg');
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (6, 1), (6, 2), (6, 3), (6, 4), (5, 5);`;
}

const ADDRESS_BOOK = `
CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT);
CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
INSERT INTO ZABCDRECORD VALUES (1, 'Ada', 'Okafor', NULL, NULL), (2, 'Tomi', NULL, NULL, NULL), (3, 'Never', 'Texted', NULL, NULL);
INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '+1 (555) 010-0100'), (2, 2, '555-010-0200'), (3, 3, '+1 555 010 9999');
INSERT INTO ZABCDEMAILADDRESS VALUES (1, 1, 'ada@example.com');`;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function fakeStore() {
  let cursor;
  return {
    saved: [],
    async readBackupCursor() {
      const { FRESH_BACKUP_CURSOR } = await import("../src/core/messages/cursor.ts");
      return { ...(cursor ?? FRESH_BACKUP_CURSOR) };
    },
    async writeBackupCursor(next) {
      cursor = { ...next };
      this.saved.push(cursor);
    },
  };
}

export async function runMessagesBackupSqliteChecks(check, skip) {
  if (!(await exists(SQLITE3))) {
    skip("the Messages backup against real SQLite fixtures", "/usr/bin/sqlite3 is not installed on this machine");
    return;
  }
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "context-messages-backup-"));
  try {
    process.env.HOME = home;
    await mkdir(join(home, "Library", "Messages"), { recursive: true });
    const chatDb = join(home, "Library", "Messages", "chat.db");
    execFileSync(SQLITE3, [chatDb, schema(MESSAGE_COLUMNS_NEW)]);
    execFileSync(SQLITE3, [chatDb, seed(true)]);
    const attachments = join(home, "Library", "Messages", "Attachments");
    for (const folder of ["aa/01", "aa/02", "aa/05"]) await mkdir(join(attachments, folder), { recursive: true });
    await writeFile(join(attachments, "aa/01/IMG_0001.HEIC"), "picture bytes");
    await writeFile(join(attachments, "aa/02/clip.MOV"), "video bytes that must stay on the Mac");
    await writeFile(join(attachments, "aa/05/taken-back.jpg"), "unsent bytes");
    const sourceDir = join(home, "Library", "Application Support", "AddressBook", "Sources", "SRC-1");
    await mkdir(sourceDir, { recursive: true });
    execFileSync(SQLITE3, [join(sourceDir, "AddressBook-v22.abcddb"), ADDRESS_BOOK]);

    const { queryChatDb, queryAddressBook } = await import("../src/core/imessage/sqlite.ts");
    const q = await import("../src/core/messages/queries.ts");
    const { recordsFromRows } = await import("../src/core/messages/records.ts");
    const { MessagesBackupService, addressBookPaths } = await import("../src/main/messagesBackup.ts");

    const columns = q.knownColumns(await queryChatDb(chatDb, q.selectMessageColumnsSql()));
    check("sqlite: the newer columns are found", columns.has("date_edited") && columns.has("date_retracted") && columns.has("service"));
    const rows = await queryChatDb(chatDb, q.selectBackupMessagesSql({ kind: "range", afterRowId: 0, throughRowId: 6 }, columns));
    const files = await queryChatDb(chatDb, q.selectBackupAttachmentsSql(0, 6));
    const records = recordsFromRows(rows, files);
    const byId = new Map(records.map((r) => [r.id, r]));
    check("sqlite: a range reads every row", rows.length === 6);
    check("sqlite: an untouched message is not read as unsent or edited", byId.get("G1")?.text === "Dinner at 4. Bring the rice?" && !("unsent" in byId.get("G1")) && !("edited" in byId.get("G1")));
    check("sqlite: an edit is read with its time", byId.get("G4")?.edited === "2026-10-21T17:22:00.000Z");
    check("sqlite: an unsend is read", byId.get("G5")?.unsent === true);
    check("sqlite: a tapback is a reaction on its target", byId.get("G3")?.kind === "reaction" && byId.get("G3").target === "G2");
    check("sqlite: a picture's name and size come through, never its path", byId.get("G6")?.files?.[0]?.name === "IMG_0001.HEIC" && byId.get("G6").files[0].bytes === 13);
    check("sqlite: a file carries the digest of Apple's id for it", byId.get("G6")?.files?.[0]?.id === createHash("sha256").update("AT-1").digest("hex").slice(0, 32));
    const fileRows = await queryChatDb(chatDb, q.selectBackupFilesSql(0, 5, columns));
    check("sqlite: the file copy reads files with their message, leaving out an unsent message's", fileRows.map((r) => r.attachment_guid).join() === "AT-1,AT-2,AT-3,AT-4" && fileRows[0].message_guid === "G6");
    const attachmentMax = await queryChatDb(chatDb, q.selectAttachmentMaxSql());
    check("sqlite: the highest file row is read", attachmentMax[0]?.max_rowid === "5");

    const changed = await queryChatDb(chatDb, q.selectBackupMessagesSql({ kind: "changed", afterNs: T(5), limit: 100 }, columns));
    check("sqlite: changes since an instant are the edited and unsent rows, oldest change first", changed.map((r) => r.guid).join() === "G4,G5");
    const forRows = await queryChatDb(chatDb, q.selectAttachmentsForRowsSql([6, 4]));
    check("sqlite: files for scattered rows are read by id", forRows.length === 4 && forRows.every((r) => r.message_guid === "G6"));
    const account = await queryChatDb(chatDb, q.selectAccountSql());
    check("sqlite: the signed-in account is read", account[0]?.login === "P:+15550104410");

    const old = join(home, "old.db");
    execFileSync(SQLITE3, [old, schema(MESSAGE_COLUMNS_OLD)]);
    execFileSync(SQLITE3, [old, seed(false)]);
    const run = (sql) => JSON.parse(execFileSync(SQLITE3, ["-readonly", "-json", old, sql]).toString() || "[]");
    const oldColumns = q.knownColumns(run(q.selectMessageColumnsSql()));
    check("sqlite: an older database has none of the newer columns", oldColumns.size === 0 && !q.canReadChanges(oldColumns));
    const oldRows = run(q.selectBackupMessagesSql({ kind: "range", afterRowId: 0, throughRowId: 6 }, oldColumns));
    check("sqlite: an older database still reads every row", oldRows.length === 6);
    check("sqlite: an older database's files are read without the newer columns", run(q.selectBackupFilesSql(0, 5, oldColumns)).length === 5);
    check("sqlite: on an older database nothing reads as edited or unsent", recordsFromRows(oldRows, []).every((r) => !("edited" in r) && !("unsent" in r)));
    let threw = false;
    try {
      q.selectBackupMessagesSql({ kind: "changed", afterNs: "1", limit: 5 }, oldColumns);
    } catch {
      threw = true;
    }
    check("sqlite: asking an older database for changes is refused before any SQL runs", threw);

    const books = await addressBookPaths();
    check("contacts: each Sources database is found", books.length === 1 && books[0].endsWith("SRC-1/AddressBook-v22.abcddb"));
    const phones = await queryAddressBook(books[0], (await import("../src/core/messages/contacts.ts")).selectPhoneNamesSql());
    check("contacts: names come with their numbers", phones.some((r) => r.first === "Ada" && r.address === "+1 (555) 010-0100"));
    let refused = false;
    try {
      await queryAddressBook(chatDb, "SELECT 1;");
    } catch {
      refused = true;
    }
    check("contacts: the Contacts reader refuses chat.db and every other path", refused);

    // The service, end to end, over the fixture and a fake gateway.
    const posts = [];
    const fileUploads = [];
    const store = fakeStore();
    const statuses = [];
    const service = new MessagesBackupService({
      store,
      connection: { baseUrl: () => "https://gateway.invalid/mcp", token: async () => "token-1", scope: () => "context:write context:private" },
      settings: () => ({ messagesBackup: true }),
      observeChatDb: () => ({ close() {} }),
      onChange: (status) => statuses.push(status),
      fetch: async (url, init) => {
        if (String(url).includes("/messages/imessage/file/")) fileUploads.push({ url: String(url), body: new TextDecoder().decode(init.body), auth: init.headers.authorization });
        else posts.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await service.runNow();
    await service.runNow();
    service.stop();
    const sent = posts.flatMap((p) => p.body.records);
    check("service: every message, reaction and chat reaches the gateway", ["G1", "G2", "G3", "G4", "G5", "G6"].every((id) => sent.some((r) => r.id === id)) && sent.some((r) => r.kind === "chat" && r.name === "Okafor family"));
    check("service: names are sent for people in the chats, and only them", sent.some((r) => r.kind === "person" && r.name === "Ada Okafor") && sent.some((r) => r.kind === "person" && r.name === "Tomi") && !sent.some((r) => r.name === "Never Texted"));
    const status = service.status();
    check("service: a finished copy says it is up to date", status.phase === "up_to_date" && status.copiedRows === 6 && status.totalRows === 6);
    check("service: the account shows masked", status.account === "+1 ••• 4410");
    check("service: how far back the copy reaches is the oldest text's time", status.reachedBack === Date.parse("2026-10-21T17:12:00.000Z"));
    check("service: the cursor ends with all history sent", store.saved.at(-1)?.oldest === 1 && store.saved.at(-1)?.newest === 6);
    const g6 = createHash("sha256").update("G6").digest("hex").slice(0, 32);
    const at1 = createHash("sha256").update("AT-1").digest("hex").slice(0, 32);
    check("service: a picture's bytes are sent once, under its message's folder", fileUploads.length === 1 && fileUploads[0].url === `https://gateway.invalid/messages/imessage/file/${g6}/${at1}` && fileUploads[0].body === "picture bytes");
    check("service: a file's credential rides in the header", fileUploads[0]?.auth === "Bearer token-1" && !fileUploads[0].url.includes("token-1"));
    check("service: no video, no unsent message's file and nothing outside Attachments is sent", !fileUploads.some((f) => /video|unsent|SQLite/.test(f.body)));
    check("service: the file positions end with every file looked at", store.saved.at(-1)?.filesOldest === 1 && store.saved.at(-1)?.filesNewest === 5 && store.saved.at(-1)?.filesBytes === 13);

    // Deleted: the cursor starts over, so turning the backup on again copies everything again.
    await service.forget();
    check("service: after the backup is deleted its cursor starts over", store.saved.at(-1)?.newest === 0 && store.saved.at(-1)?.oldest === null && store.saved.at(-1)?.filesBytes === 0 && service.status().copiedRows === 0);

    const { readAttachment } = await import("../src/main/messagesBackup.ts");
    await symlink(chatDb, join(attachments, "aa/01/link.png"));
    const linked = await readAttachment("~/Library/Messages/Attachments/aa/01/link.png");
    check("service: a link inside Attachments that points out of it is never read", "missing" in linked);
    check("service: a path that climbs out of Attachments is never read", "missing" in (await readAttachment("~/Library/Messages/Attachments/../chat.db")) && "missing" in (await readAttachment(chatDb)));

    // Off means nothing is read or sent.
    const quiet = [];
    const off = new MessagesBackupService({
      store: fakeStore(),
      connection: { baseUrl: () => "https://gateway.invalid/mcp", token: async () => "t", scope: () => "" },
      settings: () => ({ messagesBackup: false }),
      observeChatDb: () => ({ close() {} }),
      fetch: async () => {
        quiet.push(1);
        return new Response("{}");
      },
    });
    await off.runNow();
    check("service: switched off, nothing is sent and the phase says off", quiet.length === 0 && off.status().phase === "off");

    // Not connected yet: nothing is sent, and the phase says why.
    const unconnected = new MessagesBackupService({
      store: fakeStore(),
      connection: { baseUrl: () => null, token: async () => null, scope: () => null },
      settings: () => ({ messagesBackup: true }),
      observeChatDb: () => ({ close() {} }),
      fetch: async () => {
        quiet.push(1);
        return new Response("{}");
      },
    });
    await unconnected.runNow();
    unconnected.stop();
    check("service: before this Mac is connected nothing is sent", quiet.length === 0 && unconnected.status().phase === "not_connected");

    // No permission: nothing is read.
    process.env.HOME = join(home, "nobody");
    const blind = new MessagesBackupService({
      store: fakeStore(),
      connection: { baseUrl: () => "https://gateway.invalid/mcp", token: async () => "t", scope: () => "" },
      settings: () => ({ messagesBackup: true }),
      observeChatDb: () => ({ close() {} }),
      fetch: async () => {
        quiet.push(1);
        return new Response("{}");
      },
    });
    await blind.runNow();
    blind.stop();
    check("service: with no Messages database to read, nothing is sent", quiet.length === 0 && blind.status().phase === "no_messages");
  } finally {
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
}
