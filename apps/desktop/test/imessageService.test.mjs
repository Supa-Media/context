/**
 * The service that owns the timer, the toggle and the status — end to end.
 *
 * Every other iMessage suite drives one pure module. This one drives
 * `main/imessage.ts` itself against a **real fixture `chat.db`**, a real
 * `/usr/bin/sqlite3`, a stubbed `fetch`, and a fixture `HOME` — which is the
 * only place three claims can actually be measured rather than read off a
 * comment:
 *
 *  - **Off by default means nothing is read.** Not "the query is skipped
 *    somewhere downstream": the database file's own bytes and modification
 *    time are unchanged and no request left the machine, with the toggle off.
 *  - **Turning it off stops it.** The same, after a pass that really did run.
 *  - **Nothing a sender wrote reaches the status.** The fixture's handle,
 *    group name, message body and attachment filename are all hostile
 *    strings; the gateway is made to fail so `lastError` is populated; and
 *    every status this service ever emitted is searched for all four.
 *
 * Skipped honestly, never faked, when `/usr/bin/sqlite3` is absent — the same
 * rule `imessageSqlite.test.mjs` follows, and for the same reason.
 *
 * ## Sabotage record
 *
 * Measured by actually editing the source and reverting:
 *
 *   `#run`'s `if (!settings().imessageEnabled) return` removed          4 FAIL
 *   `#run`'s catch-all putting `error.message` into `lastError`         2 FAIL
 *   `upsertPart` reporting the gateway's own error text as `lastError`
 *     when that text quotes the note it refused                         2 FAIL
 */

import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SQLITE3_BINARY = "/usr/bin/sqlite3";

/** Bytes a sender chose, in every column that carries any. None may reach a status. */
const HOSTILE = Object.freeze({
  handle: "+15550009999",
  groupName: "Sensitive Group Name",
  body: "the secret body of a private message",
  filename: "confidential-attachment.heic",
});

const SCHEMA_SQL = `
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE NOT NULL,
  text TEXT,
  handle_id INTEGER,
  date INTEGER,
  is_from_me INTEGER DEFAULT 0,
  associated_message_type INTEGER DEFAULT 0,
  associated_message_guid TEXT,
  attributedBody BLOB
);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, chat_identifier TEXT, display_name TEXT, service_name TEXT);
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, service TEXT);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT, mime_type TEXT, total_bytes INTEGER, transfer_name TEXT);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
`;

function sqlLiteral(value) {
  return `'${String(value).split("'").join("''")}'`;
}

function buildFixtureDb(dbPath) {
  execFileSync(SQLITE3_BINARY, [dbPath, SCHEMA_SQL]);
  execFileSync(SQLITE3_BINARY, [
    dbPath,
    `
    INSERT INTO handle (ROWID, id, service) VALUES (1, ${sqlLiteral(HOSTILE.handle)}, 'iMessage');
    INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name)
      VALUES (1, 'chat-guid-service', 'chat4242', ${sqlLiteral(HOSTILE.groupName)}, 'iMessage');
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1);
    INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me)
      VALUES (1, 'msg-service-1', ${sqlLiteral(HOSTILE.body)}, 1, 810432840000000000, 0);
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
    INSERT INTO attachment (ROWID, filename, mime_type, total_bytes, transfer_name)
      VALUES (1, ${sqlLiteral(HOSTILE.filename)}, 'image/heic', 512, 'x.heic');
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 1);
  `,
  ]);
}

async function dbFingerprint(dbPath) {
  const info = await stat(dbPath);
  return `${createHash("sha256").update(await readFile(dbPath)).digest("hex")}:${info.size}:${info.mtimeMs}`;
}

/** Everything the service is allowed to see of a gateway connection, and no more. */
function fakeConnection() {
  return {
    baseUrl: () => "https://gateway.invalid/mcp",
    token: async () => "not-a-real-token",
    scope: () => "context:write context:private",
  };
}

function fakeStore() {
  let cursor = { version: 1, lastRowId: 0 };
  return {
    written: [],
    async readImessageCursor() {
      return { ...cursor };
    },
    async writeImessageCursor(next) {
      cursor = { ...next };
      this.written.push({ ...next });
    },
  };
}

/**
 * A `fetch` that speaks just enough MCP to answer `read_note` and `write_note`,
 * recording every request body so a test can say what actually crossed.
 */
function stubFetch({ failWrites = false } = {}) {
  const requests = [];
  const notes = new Map();
  const impl = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push(body);
    const name = body?.params?.name;
    const args = body?.params?.arguments ?? {};
    const answer = (text, isError = false) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError, content: [{ type: "text", text }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (name === "read_note") {
      const stored = notes.get(args.path);
      return stored === undefined
        ? answer("not found", true)
        : answer(`etag: ${stored.etag}\npath: ${args.path}\n\n${stored.content}`);
    }
    if (name === "write_note") {
      if (failWrites) {
        // A refusal that deliberately QUOTES the note it refused, which is the
        // one thing a pass-through of the gateway's own words would leak.
        return answer(`refused: this note is not writable: ${String(args.content).slice(0, 400)}`, true);
      }
      const etag = `etag-${notes.size + 1}`;
      notes.set(args.path, { content: args.content, etag });
      return answer(`written: ${args.path} (etag ${etag})`);
    }
    return answer(`unknown tool ${name}`, true);
  };
  return { impl, requests, notes };
}

export async function runImessageServiceChecks(check, skip) {
  try {
    await access(SQLITE3_BINARY);
  } catch {
    skip("the iMessage service against a real fixture chat.db", "/usr/bin/sqlite3 is not installed on this machine");
    return;
  }

  const { ImessageSyncService } = await import("../src/main/imessage.ts");

  const tempHome = await mkdtemp(join(tmpdir(), "context-imessage-service-"));
  const messagesDir = join(tempHome, "Library", "Messages");
  await mkdir(messagesDir, { recursive: true });
  const dbPath = join(messagesDir, "chat.db");
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.HOME;
  let service = null;

  try {
    buildFixtureDb(dbPath);
    // `paths.ts` compares every candidate against `homedir()/Library/Messages/
    // chat.db` and refuses anything else, so pointing HOME at the fixture home
    // is what makes the fixture database the one allowed file — the service's
    // own `chatDbPath` override cannot widen that, which is checked below.
    process.env.HOME = tempHome;

    // -- OFF BY DEFAULT: nothing is read, nothing is sent -------------------
    const offGateway = stubFetch();
    globalThis.fetch = offGateway.impl;
    const offStore = fakeStore();
    const offStatuses = [];
    let enabled = false;
    service = new ImessageSyncService({
      store: offStore,
      connection: fakeConnection(),
      settings: () => ({ imessageEnabled: enabled }),
      onChange: (status) => offStatuses.push(status),
      chatDbPath: () => dbPath,
    });

    const untouched = await dbFingerprint(dbPath);
    service.reconfigure();
    await service.syncNow();
    check("the setting this service reads is off before anybody touches it", service.status().enabled === false);
    check(
      "WITH THE TOGGLE OFF, NOT ONE REQUEST LEAVES THE MACHINE — no read_note, no write_note, nothing",
      offGateway.requests.length === 0,
    );
    check("...and the database's own bytes and modification time are untouched", (await dbFingerprint(dbPath)) === untouched);
    check("...and no cursor was ever written, so nothing was read to advance one", offStore.written.length === 0);
    check(
      "...and the permission was not even probed, since there is nothing to probe it for",
      offStatuses.every((status) => status.permission === "unknown"),
    );

    // -- TURNED ON: one pass runs, and the day lands ------------------------
    enabled = true;
    service.reconfigure();
    await service.syncNow();
    service.stop();
    const wroteNote = offGateway.requests.find((request) => request?.params?.name === "write_note");
    check("turned on, the pass runs and a channel-day note is written", wroteNote !== undefined);
    check(
      "...at the fixed iMessage path for the day the fixture's message falls on",
      wroteNote?.params?.arguments?.path === "0-inbox/imessage/2026-09-07.md",
    );
    check("...as a private note, never team-visible", wroteNote?.params?.arguments?.visibility === "private");
    check("...and the message really is in it, which is the point of the feature", String(wroteNote?.params?.arguments?.content).includes(HOSTILE.body));
    check("...and the cursor advanced past the row it read", offStore.written.at(-1)?.lastRowId === 1);
    check("...and the database was still never written to", (await dbFingerprint(dbPath)) === untouched);
    check("...and the credential never crossed as anything but an Authorization header", !JSON.stringify(offGateway.requests).includes("not-a-real-token"));

    // -- TURNED BACK OFF: it stops --------------------------------------------
    enabled = false;
    service.reconfigure();
    const requestsAtOff = offGateway.requests.length;
    await service.syncNow();
    check("TURNED BACK OFF, A SYNC DOES NOTHING — the toggle is read every pass, not once at launch", offGateway.requests.length === requestsAtOff);
    check("...and the status says so", service.status().enabled === false);
    service.stop();

    // -- A FAILING GATEWAY: lastError is set, and carries none of it ---------
    const failing = stubFetch({ failWrites: true });
    globalThis.fetch = failing.impl;
    const failStore = fakeStore();
    const failStatuses = [];
    let failEnabled = true;
    service = new ImessageSyncService({
      store: failStore,
      connection: fakeConnection(),
      settings: () => ({ imessageEnabled: failEnabled }),
      onChange: (status) => failStatuses.push(status),
      chatDbPath: () => dbPath,
    });
    service.reconfigure();
    await service.syncNow();
    service.stop();

    const finalStatus = service.status();
    check("a refused write really does surface as an error a person can see", typeof finalStatus.lastError === "string" && finalStatus.lastError.length > 0);
    check("...and the cursor is held back, so the day is retried rather than lost", failStore.written.at(-1)?.lastRowId === 0);

    // The gateway's refusal quoted the whole note back. Every status this
    // service emitted, plus the one it answers now, is searched for all four
    // pieces of sender-written content.
    const everyStatus = JSON.stringify([...failStatuses, finalStatus]);
    for (const [what, value] of Object.entries(HOSTILE)) {
      check(
        `NO ${what.toUpperCase()} REACHES THE STATUS, even when the gateway's own refusal quotes the note back`,
        !everyStatus.includes(value),
      );
    }
    check(
      "...and nothing recognisably note-shaped leaks either — no frontmatter, no fence, no path",
      !everyStatus.includes("context:untrusted-communication") &&
        !everyStatus.includes("0-inbox/") &&
        !everyStatus.includes("channel-day"),
    );
    check(
      "...and the cursor file holds a row number and a version, and no content at all",
      failStore.written.every((entry) => Object.keys(entry).sort().join(",") === "lastRowId,version"),
    );

    // -- NO chat.db AT ALL: unknown, not denied, and no gateway traffic ------
    const noDb = stubFetch();
    globalThis.fetch = noDb.impl;
    service = new ImessageSyncService({
      store: fakeStore(),
      connection: fakeConnection(),
      settings: () => ({ imessageEnabled: true }),
      chatDbPath: () => join(tempHome, "Library", "Messages", "no-such-chat.db"),
    });
    await service.syncNow();
    service.stop();
    check(
      "a Mac with no chat.db reports UNKNOWN, never denied — telling somebody to grant a permission that would not help is a dead end",
      service.status().permission === "unknown",
    );
    check("...and nothing was sent to the gateway for a database that is not there", noDb.requests.length === 0);
    // -- THE `chatDbPath` OVERRIDE CANNOT WIDEN WHAT MAY BE READ -----------
    //
    // The service takes a `chatDbPath` for the suite's benefit. It is not a
    // way in: `paths.ts` is asked again inside `sqlite.ts`, after the seam, so
    // a path this service was handed that is not this Mac's own `chat.db` is
    // refused before `/usr/bin/sqlite3` is spawned — even when it names a
    // perfectly readable database.
    const decoyDb = join(tempHome, "decoy-chat.db");
    execFileSync(SQLITE3_BINARY, [decoyDb, SCHEMA_SQL]);
    execFileSync(SQLITE3_BINARY, [
      decoyDb,
      `INSERT INTO handle (ROWID, id, service) VALUES (1, 'someone-elses-database', 'iMessage');`,
    ]);
    const decoyGateway = stubFetch();
    globalThis.fetch = decoyGateway.impl;
    const decoyStore = fakeStore();
    service = new ImessageSyncService({
      store: decoyStore,
      connection: fakeConnection(),
      settings: () => ({ imessageEnabled: true }),
      chatDbPath: () => decoyDb,
    });
    await service.syncNow();
    service.stop();
    check(
      "A `chatDbPath` NAMING A READABLE DATABASE OUTSIDE ~/Library/Messages READS NOTHING FROM IT",
      decoyGateway.requests.length === 0,
    );
    check("...and says only that the pass could not complete, never which file or why", service.status().lastError === "iMessage import could not complete a sync pass");
    check("...and no cursor is written at all, so nothing about that file is remembered", decoyStore.written.length === 0);
  } finally {
    service?.stop();
    globalThis.fetch = originalFetch;
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  }
}
