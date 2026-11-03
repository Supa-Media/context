/**
 * THE CHAT'S LEDGER: the one record of everything that happened in a chat
 * with Tex (decided by the owner, 2026-11-02: "one JSON file for the
 * structured data … with a manifest … store it in a durable object for every
 * group chat, for every one-on-one, and rebuild" every view from it;
 * `docs/decisions/texting-assistant/chat-ledger.md`).
 *
 * Kept in the chat's own Tex Durable Object (`person:<workspaceId>` for a
 * one-to-one chat, `chat:<groupKey>` for a group), in its SQLite: one row per
 * entry, appended and never edited, so adding a line never rewrites the file.
 * Read back, a chat's rows are one JSON document, its manifest first
 * (`readLedger`), which is what an export writes.
 *
 * The object checks only the envelope (a known kind, a size it keeps); what
 * an entry says, and what is left out of it, is the gateway's
 * (`agent/ledger.js`). Pure over a `sql` with the Durable Object's shape, so
 * the Node tests run it against `node:sqlite`.
 */

import { TexObjectRefused } from "./objects.js";

/** The ledger's format: a reader of a newer version than it knows reads none of it rather than misreading it. */
export const LEDGER_SCHEMA = "tex-ledger";
export const LEDGER_VERSION = 1;

/** What one entry may be about (`agent/ledger.js` says what each carries). */
export const LEDGER_KINDS = new Set(["text", "thinking", "said", "tool", "advisor", "mail_check", "job", "reply", "note"]);

/** One entry, as JSON: a long tool result is cut by the gateway well before this. */
export const MAX_ENTRY_BYTES = 512 * 1024;
/** The most entries one append takes. */
export const MAX_APPEND = 100;
/** The most entries one read answers; a reader pages on with `after` or `before`. */
export const MAX_READ = 5000;

const CHAT = /^[A-Za-z0-9_.:@+=-]{1,128}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ledger (
    chat TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    entry TEXT NOT NULL,
    PRIMARY KEY (chat, seq),
    UNIQUE (chat, id)
  )`,
  `CREATE TABLE IF NOT EXISTS ledger_chats (
    chat TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    count INTEGER NOT NULL,
    bytes INTEGER NOT NULL
  )`,
];

const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
const encoder = new TextEncoder();

function checkChat(chat) {
  if (typeof chat !== "string" || !CHAT.test(chat)) throw new TexObjectRefused("not a chat this ledger keeps");
  return chat;
}

/** The entry as kept: the envelope checked, `v` and `seq` set by the ledger. */
function checkEntry(entry, now) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new TexObjectRefused("an entry is an object");
  if (!LEDGER_KINDS.has(entry.kind)) throw new TexObjectRefused("an entry of a kind this ledger does not keep");
  if (typeof entry.id !== "string" || !ID.test(entry.id)) throw new TexObjectRefused("an entry needs an id");
  const at = Number.isSafeInteger(entry.at) && entry.at > 0 ? entry.at : now;
  const { seq: _seq, v: _v, ...rest } = entry;
  return { v: LEDGER_VERSION, ...rest, at };
}

/**
 * The ledger over one Durable Object's `sql`.
 *
 * @param {{exec: (query: string, ...binds: unknown[]) => {toArray(): object[]}}} sql
 * @param {{now?: () => number, guard?: () => void}} [options] `guard` runs before every write and throws to stop it (`move.js`).
 */
export function texLedger(sql, { now = Date.now, guard = () => {} } = {}) {
  for (const statement of SCHEMA) sql.exec(statement);

  const manifestRow = (chat) => rows(sql.exec("SELECT * FROM ledger_chats WHERE chat = ?", chat))[0] ?? null;

  function manifestOf(chat) {
    const row = manifestRow(chat);
    return {
      schema: LEDGER_SCHEMA,
      version: LEDGER_VERSION,
      chat,
      created: row ? Number(row.created) : null,
      updated: row ? Number(row.updated) : null,
      count: row ? Number(row.count) : 0,
      bytes: row ? Number(row.bytes) : 0,
    };
  }

  return {
    /**
     * Add entries to a chat's ledger, in order. All are checked before any is
     * kept; one whose id is already in the ledger is left out (a retried
     * append keeps one copy). Answers the kinds added and the newest `seq`.
     */
    append(chat, entries) {
      checkChat(chat);
      if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_APPEND) throw new TexObjectRefused(`an append takes 1 to ${MAX_APPEND} entries`);
      const at = now();
      const checked = entries.map((entry) => {
        const kept = checkEntry(entry, at);
        const text = JSON.stringify(kept);
        if (encoder.encode(text).byteLength > MAX_ENTRY_BYTES) throw new TexObjectRefused(`an entry larger than ${MAX_ENTRY_BYTES} bytes`);
        return { kept, text };
      });
      guard();
      const seen = new Set();
      let seq = Number(rows(sql.exec("SELECT COALESCE(MAX(seq), 0) AS seq FROM ledger WHERE chat = ?", chat))[0]?.seq ?? 0);
      let added = 0;
      let bytes = 0;
      const kinds = new Set();
      for (const { kept, text } of checked) {
        if (seen.has(kept.id)) continue;
        seen.add(kept.id);
        // An id already kept (a retried append) is left as it was: the unique (chat, id) keeps one copy.
        if (rows(sql.exec("SELECT 1 AS one FROM ledger WHERE chat = ? AND id = ?", chat, kept.id)).length > 0) continue;
        seq += 1;
        sql.exec("INSERT INTO ledger (chat, seq, id, at, kind, entry) VALUES (?, ?, ?, ?, ?, ?)", chat, seq, kept.id, kept.at, kept.kind, text);
        added += 1;
        bytes += text.length;
        kinds.add(kept.kind);
      }
      if (added > 0) {
        const row = manifestRow(chat);
        if (row === null) sql.exec("INSERT INTO ledger_chats (chat, version, created, updated, count, bytes) VALUES (?, ?, ?, ?, ?, ?)", chat, LEDGER_VERSION, at, at, added, bytes);
        else sql.exec("UPDATE ledger_chats SET updated = ?, count = count + ?, bytes = bytes + ? WHERE chat = ?", at, added, bytes, chat);
      }
      return { added, seq, kinds: [...kinds] };
    },

    /**
     * Put entries before everything the chat's ledger holds, in the order
     * given (oldest first): what the chat said before its ledger began, copied
     * in once (`agent/ledgerBackfill.js`). Their `seq` counts down from the
     * oldest kept, so every reader still reads the chat in order. An id
     * already kept is left out, as in `append`.
     */
    prepend(chat, entries) {
      checkChat(chat);
      if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_APPEND) throw new TexObjectRefused(`a prepend takes 1 to ${MAX_APPEND} entries`);
      const at = now();
      const checked = entries.map((entry) => {
        const kept = checkEntry(entry, at);
        const text = JSON.stringify(kept);
        if (encoder.encode(text).byteLength > MAX_ENTRY_BYTES) throw new TexObjectRefused(`an entry larger than ${MAX_ENTRY_BYTES} bytes`);
        return { kept, text };
      });
      guard();
      const fresh = [];
      const seen = new Set();
      for (const item of checked) {
        if (seen.has(item.kept.id)) continue;
        seen.add(item.kept.id);
        if (rows(sql.exec("SELECT 1 AS one FROM ledger WHERE chat = ? AND id = ?", chat, item.kept.id)).length > 0) continue;
        fresh.push(item);
      }
      const lowest = rows(sql.exec("SELECT MIN(seq) AS seq FROM ledger WHERE chat = ?", chat))[0]?.seq;
      let seq = (lowest === null || lowest === undefined ? 1 : Number(lowest)) - fresh.length;
      let bytes = 0;
      const kinds = new Set();
      for (const { kept, text } of fresh) {
        sql.exec("INSERT INTO ledger (chat, seq, id, at, kind, entry) VALUES (?, ?, ?, ?, ?, ?)", chat, seq, kept.id, kept.at, kept.kind, text);
        seq += 1;
        bytes += text.length;
        kinds.add(kept.kind);
      }
      if (fresh.length > 0) {
        const row = manifestRow(chat);
        const oldest = Math.min(...fresh.map(({ kept }) => kept.at));
        if (row === null) sql.exec("INSERT INTO ledger_chats (chat, version, created, updated, count, bytes) VALUES (?, ?, ?, ?, ?, ?)", chat, LEDGER_VERSION, oldest, at, fresh.length, bytes);
        else sql.exec("UPDATE ledger_chats SET created = MIN(created, ?), count = count + ?, bytes = bytes + ? WHERE chat = ?", oldest, fresh.length, bytes, chat);
      }
      return { added: fresh.length, kinds: [...kinds] };
    },

    /** The oldest entry a chat's ledger keeps, `{id, at}`, or null when it keeps none. */
    oldest(chat) {
      checkChat(chat);
      const found = rows(sql.exec("SELECT id, at FROM ledger WHERE chat = ? ORDER BY seq LIMIT 1", chat))[0];
      return found ? { id: String(found.id), at: Number(found.at) } : null;
    },

    /**
     * A chat's ledger as one document: `{manifest, entries}`, each entry with
     * its `seq`. Oldest first; with `before`, the newest `limit` entries
     * before that seq, newest first. `after` reads on from a seq, `kinds`
     * keeps only those kinds. `next` is the seq to pass as `after` for more,
     * when the read stopped at `limit`. `slim` leaves out a tool call's
     * arguments and result and a reply's words (what a turn's prompt reads);
     * `since` / `until` keep entries in that span of time.
     */
    read(chat, { after = null, before = null, kinds = null, limit = MAX_READ, slim = false, since = null, until = null, job = null, jobs = true } = {}) {
      checkChat(chat);
      const size = Math.min(MAX_READ, Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_READ);
      const wanted = Array.isArray(kinds) ? kinds.filter((kind) => LEDGER_KINDS.has(kind)) : null;
      const kindClause = wanted === null ? "" : wanted.length === 0 ? " AND 0" : ` AND kind IN (${wanted.map(() => "?").join(",")})`;
      // `since` / `until`: only entries at or after, and before, those times (a day in the viewer).
      const from = Number.isSafeInteger(since) ? since : null;
      const to = Number.isSafeInteger(until) ? until : null;
      const timeClause = `${from === null ? "" : " AND at >= ?"}${to === null ? "" : " AND at < ?"}`;
      // `job`: only that job's work (entries a job's turn wrote carry `jobId`, `agent/ledger.js` `jobTagged`) and its own
      // `job` entries; `jobs: false`: none of any job's work. Either way the chat's own lines are left as they are.
      const oneJob = typeof job === "string" && ID.test(job) ? job : null;
      const jobClause = oneJob !== null ? " AND (json_extract(entry, '$.jobId') = ? OR (kind = 'job' AND json_extract(entry, '$.job') = ?))" : jobs === false ? " AND json_extract(entry, '$.jobId') IS NULL" : "";
      const binds = [...(wanted ?? []), ...(from === null ? [] : [from]), ...(to === null ? [] : [to]), ...(oneJob !== null ? [oneJob, oneJob] : [])];
      const newest = Number.isSafeInteger(before);
      const found = newest
        ? rows(sql.exec(`SELECT seq, entry FROM ledger WHERE chat = ? AND seq < ?${kindClause}${timeClause}${jobClause} ORDER BY seq DESC LIMIT ?`, chat, before, ...binds, size + 1))
        : rows(sql.exec(`SELECT seq, entry FROM ledger WHERE chat = ? AND seq > ?${kindClause}${timeClause}${jobClause} ORDER BY seq LIMIT ?`, chat, Number.isSafeInteger(after) ? after : -Number.MAX_SAFE_INTEGER, ...binds, size + 1));
      const more = found.length > size;
      const entries = found.slice(0, size).map((row) => {
        const entry = { ...JSON.parse(row.entry), seq: Number(row.seq) };
        if (slim === true) {
          delete entry.args;
          delete entry.result;
          if (entry.kind === "reply") delete entry.text; // its words are the chat's text events; a reader wants its turn and `clean`
          delete entry.timing; // where a reply's time went is for the history view, never a turn's reads
        }
        return entry;
      });
      const last = entries.at(-1)?.seq;
      return { manifest: manifestOf(chat), entries, ...(more ? (newest ? { before: last } : { next: last }) : {}) };
    },

    /** The chats this object keeps a ledger for, with their manifests. */
    chats() {
      return rows(sql.exec("SELECT chat FROM ledger_chats ORDER BY chat")).map((row) => manifestOf(row.chat));
    },

    /** Every ledger this object keeps, removed (an account, a phone link or a group chat ending). */
    wipe() {
      guard();
      sql.exec("DELETE FROM ledger");
      sql.exec("DELETE FROM ledger_chats");
    },
  };
}
