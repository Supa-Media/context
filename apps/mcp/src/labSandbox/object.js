/**
 * ONE LAB TEST CHAT'S OWN OBJECT (Dev2, 2026-11-16: "all the changes in the workspace / group chat object be sandboxed
 * so it doesn't actually affect production"; `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * Named `labsandbox:<userId>:<sandboxId>` (`sandboxName`), reached only from this gateway's `/tex-lab/sandbox` route
 * and the test chat's own turns. It keeps the test chat and nothing that is anybody's real data but a copy of the
 * chat's history up to where it started:
 *
 *  - `rows`: the chat as the Lab shows it, the real texts it started from (`prod: true`) and every test text and
 *    reply after them;
 *  - `writes`: everything a test turn would have changed or sent, each said in a line, by the text that caused it;
 *  - `kv`: the copy-on-write overlay. A test turn's put or delete on a real workspace or Tex object lands here, keyed
 *    by that object's name and key, and a read of that key answers from here first (`wire.js`);
 *  - the test chat's ledger (`texStore/ledger.js`, the real one's code): its real history up to the start, copied at
 *    open, and every entry a test turn writes, kept per text so Retry, Back and Drop can cut it.
 *
 * It holds one person's test chat and expires: Reset deletes everything, and an alarm deletes it all 24 hours after
 * its last use.
 */

import { texLedger } from "../texStore/ledger.js";
import { objectByName } from "../objectPlace.js";

export const SANDBOX_TTL_MS = 24 * 3_600_000;
/**
 * The most test rows (texts, tapbacks and Tex's replies) one test chat keeps. The real texts it started from are never
 * capped: a test chat opens on the whole chat (Dev2, 2026-11-16: "its not truly loading the entire converstation history").
 */
export const MAX_ROWS = 600;
/** The real history is kept, and sent here, in pieces this size: one Durable Object row holds 2 MB. */
export const SEED_CHUNK = 200;
/** The most writes kept, and the largest overlay body (a Durable Object row holds 2 MB). */
export const MAX_WRITES = 500;
export const MAX_KV_BYTES = 1_500_000;
const ORIGIN = "https://lab-sandbox.internal";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS sb_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sb_rows (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sb_writes (seq INTEGER PRIMARY KEY, by_row TEXT, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sb_kv (seq INTEGER PRIMARY KEY, obj TEXT NOT NULL, key TEXT NOT NULL, by_row TEXT, gone INTEGER NOT NULL, meta TEXT, body BLOB)",
  "CREATE INDEX IF NOT EXISTS sb_kv_key ON sb_kv (obj, key, seq)",
  "CREATE TABLE IF NOT EXISTS sb_ledger (seq INTEGER PRIMARY KEY, by_row TEXT, entries TEXT NOT NULL)",
];

const all = (cursor) => (cursor && typeof cursor.toArray === "function" ? cursor.toArray() : []);

/** The object's name: one person's one test chat. Ids are checked by the route before they reach here. */
export function sandboxName(userId, sandboxId) {
  return `labsandbox:${userId}:${sandboxId}`;
}

/** The gateway's stub for one test chat's object, or null on a deployment without the binding. */
export function sandboxStub(env, userId, sandboxId) {
  const namespace = env?.LAB_SANDBOX;
  if (!namespace || typeof namespace.idFromName !== "function") return null;
  return objectByName(namespace, sandboxName(userId, sandboxId));
}

/** One call to the object: `op` and its JSON fields, its JSON answer back. Throws when the object refuses. */
export async function callSandbox(stub, op, fields = {}) {
  const response = await stub.fetch(new Request(`${ORIGIN}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) }));
  if (!response.ok) {
    const said = await response.json().catch(() => null);
    throw new Error(`lab sandbox ${op} failed (${response.status})${typeof said?.message === "string" ? `: ${said.message}` : ""}`);
  }
  return await response.json();
}

const toBytes = (value) => (value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(0));
const b64 = (bytes) => {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
};
const unb64 = (text) => Uint8Array.from(atob(String(text ?? "")), (c) => c.charCodeAt(0));

/** The test chat's tables over one SQLite handle (the object's, or a test's). */
export function sandboxTables(sql, { now = Date.now } = {}) {
  for (const statement of SCHEMA) sql.exec(statement);
  const ledger = texLedger(sql, { now });
  const meta = () => Object.fromEntries(all(sql.exec("SELECT k, v FROM sb_meta")).map((row) => [row.k, JSON.parse(row.v)]));
  const setMeta = (k, v) => (v === undefined || v === null ? sql.exec("DELETE FROM sb_meta WHERE k = ?", k) : sql.exec("INSERT OR REPLACE INTO sb_meta (k, v) VALUES (?, ?)", k, JSON.stringify(v)));
  const rows = () => all(sql.exec("SELECT seq, data FROM sb_rows ORDER BY seq")).map((row) => JSON.parse(row.data));
  const writes = () => all(sql.exec("SELECT data FROM sb_writes ORDER BY seq")).map((row) => JSON.parse(row.data));
  const nextSeq = (table) => Number(all(sql.exec(`SELECT COALESCE(MAX(seq), 0) AS n FROM ${table}`))[0]?.n ?? 0) + 1;

  /** Rebuilds the chat's ledger from what is kept: the real history first, then each test text's entries in order. */
  function rebuildLedger() {
    const chat = meta().chat?.ledgerChat;
    ledger.wipe();
    if (typeof chat !== "string") return;
    for (const row of all(sql.exec("SELECT entries FROM sb_ledger ORDER BY seq"))) {
      const entries = JSON.parse(row.entries);
      for (let at = 0; at < entries.length; at += 100) {
        try {
          ledger.append(chat, entries.slice(at, at + 100));
        } catch {
          /* an entry the ledger refuses is left out, as the real ledger would */
        }
      }
    }
  }

  /** Everything from row `fromId` on (it included): its rows, their writes, their overlay changes and ledger entries. */
  function cutFrom(fromId) {
    const target = all(sql.exec("SELECT seq FROM sb_rows WHERE id = ?", fromId))[0];
    if (!target) return false;
    const gone = all(sql.exec("SELECT id FROM sb_rows WHERE seq >= ?", target.seq)).map((row) => row.id);
    sql.exec("DELETE FROM sb_rows WHERE seq >= ?", target.seq);
    for (const id of gone) {
      sql.exec("DELETE FROM sb_writes WHERE by_row = ?", id);
      sql.exec("DELETE FROM sb_kv WHERE by_row = ?", id);
      sql.exec("DELETE FROM sb_ledger WHERE by_row = ?", id);
    }
    rebuildLedger();
    return true;
  }

  return {
    ledger,
    meta,
    setMeta,
    rows,
    writes,
    /** A new test chat: what it is, and the first piece of the rows it starts from and the real history (`seed` the rest). */
    init({ about, rows: start = [], history = [] }) {
      ledger.wipe();
      for (const table of ["sb_meta", "sb_rows", "sb_writes", "sb_kv", "sb_ledger"]) sql.exec(`DELETE FROM ${table}`);
      setMeta("chat", about);
      setMeta("createdAt", now());
      this.seed({ rows: start, history });
    },
    /**
     * More of the real chat a test chat starts from, oldest first after what is kept, before any test text: its rows,
     * and its history into the ledger, kept in pieces of `SEED_CHUNK`. Never capped.
     */
    seed({ rows: more = [], history = [] }) {
      if (all(sql.exec("SELECT COUNT(*) AS n FROM sb_rows WHERE data NOT LIKE '%\"prod\":true%'"))[0]?.n > 0) throw new Error("seeded after a test text");
      let seq = nextSeq("sb_rows");
      for (const row of more) {
        sql.exec("INSERT OR IGNORE INTO sb_rows (seq, id, data) VALUES (?, ?, ?)", seq, row.id, JSON.stringify(row));
        seq += 1;
      }
      const chat = meta().chat?.ledgerChat;
      for (let at = 0; at < history.length; at += SEED_CHUNK) {
        const piece = history.slice(at, at + SEED_CHUNK);
        sql.exec("INSERT INTO sb_ledger (seq, by_row, entries) VALUES (?, NULL, ?)", nextSeq("sb_ledger"), JSON.stringify(piece));
        if (typeof chat !== "string") continue;
        for (let from = 0; from < piece.length; from += 100) {
          try {
            ledger.append(chat, piece.slice(from, from + 100));
          } catch {
            /* an entry the ledger refuses is left out, as the real ledger would */
          }
        }
      }
    },
    addRow(row) {
      if (all(sql.exec("SELECT COUNT(*) AS n FROM sb_rows WHERE data NOT LIKE '%\"prod\":true%'"))[0]?.n >= MAX_ROWS) throw new Error("full");
      sql.exec("INSERT INTO sb_rows (seq, id, data) VALUES (?, ?, ?)", nextSeq("sb_rows"), row.id, JSON.stringify(row));
    },
    patchRow(id, patch) {
      const found = all(sql.exec("SELECT data FROM sb_rows WHERE id = ?", id))[0];
      if (!found) return false;
      sql.exec("UPDATE sb_rows SET data = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(found.data), ...patch }), id);
      return true;
    },
    cutFrom,
    /** Keeps `id` and the reply rows straight after it; cuts from the next text on. */
    cutAfter(id) {
      const list = rows();
      const at = list.findIndex((row) => row.id === id);
      if (at < 0) return false;
      let next = at + 1;
      while (next < list.length && list[next].reply === id) next += 1;
      if (next < list.length) cutFrom(list[next].id);
      return true;
    },
    addWrite(write) {
      if (all(sql.exec("SELECT COUNT(*) AS n FROM sb_writes"))[0]?.n >= MAX_WRITES) return;
      sql.exec("INSERT INTO sb_writes (seq, by_row, data) VALUES (?, ?, ?)", nextSeq("sb_writes"), write.by ?? null, JSON.stringify(write));
    },
    /** The overlay's newest record of one key: `{gone, meta, body?}`, or null when this test chat never changed it. */
    kvGet(obj, key) {
      const row = all(sql.exec("SELECT gone, meta, body FROM sb_kv WHERE obj = ? AND key = ? ORDER BY seq DESC LIMIT 1", obj, key))[0];
      if (!row) return null;
      return { gone: Number(row.gone) === 1, meta: row.meta ? JSON.parse(row.meta) : null, body: row.body === null || row.body === undefined ? null : b64(toBytes(row.body)) };
    },
    kvPut(obj, key, { meta: kept, body, gone = false, by = null }) {
      const bytes = body ? unb64(body) : null;
      if (bytes && bytes.byteLength > MAX_KV_BYTES) throw new Error("too_big");
      sql.exec("INSERT INTO sb_kv (seq, obj, key, by_row, gone, meta, body) VALUES (?, ?, ?, ?, ?, ?, ?)", nextSeq("sb_kv"), obj, key, by, gone ? 1 : 0, kept ? JSON.stringify(kept) : null, bytes);
    },
    /** Every key under `prefix` this test chat changed, newest record each. */
    kvList(obj, prefix = "") {
      const out = new Map();
      for (const row of all(sql.exec("SELECT key, gone, meta FROM sb_kv WHERE obj = ? ORDER BY seq", obj))) {
        if (String(row.key).startsWith(prefix)) out.set(row.key, { key: row.key, gone: Number(row.gone) === 1, meta: row.meta ? JSON.parse(row.meta) : null });
      }
      return [...out.values()];
    },
    /** Ledger entries a test turn wrote, kept for its text. */
    ledgerAppend(entries, by) {
      const chat = meta().chat?.ledgerChat;
      if (typeof chat !== "string") return { added: 0, seq: 0, kinds: [] };
      sql.exec("INSERT INTO sb_ledger (seq, by_row, entries) VALUES (?, ?, ?)", nextSeq("sb_ledger"), by ?? null, JSON.stringify(entries));
      return ledger.append(chat, entries);
    },
    /** The ledger entries one test text's turn wrote, in order. */
    ledgerOf(rowId) {
      return all(sql.exec("SELECT entries FROM sb_ledger WHERE by_row = ? ORDER BY seq", rowId)).flatMap((row) => JSON.parse(row.entries));
    },
    wipe() {
      for (const table of ["sb_meta", "sb_rows", "sb_writes", "sb_kv", "sb_ledger"]) sql.exec(`DELETE FROM ${table}`);
      ledger.wipe();
    },
  };
}

/** The ops the gateway asks of a test chat's object, by name. Each answers JSON. */
export function serveSandbox(tables, op, body) {
  switch (op) {
    case "init":
      tables.init(body);
      return { ok: true };
    case "seed":
      tables.seed(body);
      return { ok: true };
    case "state":
      return { meta: tables.meta(), rows: tables.rows(), writes: tables.writes() };
    case "meta":
      tables.setMeta(body.key, body.value);
      return { ok: true };
    case "row.add":
      tables.addRow(body.row);
      return { ok: true };
    case "row.patch":
      return { ok: tables.patchRow(body.id, body.patch ?? {}) };
    case "cut.from":
      return { ok: tables.cutFrom(body.id) };
    case "cut.after":
      return { ok: tables.cutAfter(body.id) };
    case "write.add":
      tables.addWrite(body.write);
      return { ok: true };
    case "kv.get":
      return { found: tables.kvGet(body.obj, body.key) };
    case "kv.put":
      tables.kvPut(body.obj, body.key, body);
      return { ok: true };
    case "kv.list":
      return { keys: tables.kvList(body.obj, body.prefix ?? "") };
    case "ledger.append":
      return tables.ledgerAppend(body.entries, body.by);
    case "ledger.read":
      return tables.ledger.read(body.chat, body.options ?? {});
    case "ledger.oldest":
      return { oldest: tables.ledger.oldest(body.chat) };
    case "ledger.of":
      return { entries: tables.ledgerOf(body.by) };
    case "reset":
      tables.wipe();
      return { ok: true };
    case "count": {
      // A counter kept in this object's meta (the person's index object: their sends today), raised only under `max`.
      const n = Number(tables.meta()[body.key] ?? 0);
      if (!Number.isSafeInteger(body.max) || n >= body.max) return { ok: false, n };
      tables.setMeta(body.key, n + 1);
      return { ok: true, n: n + 1 };
    }
    default:
      return null;
  }
}

/** The Durable Object class (`LabSandbox` in `wrangler.toml`). */
export class LabSandboxObject {
  constructor(state) {
    this.state = state;
    this.tables = null;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const op = new URL(request.url).pathname.slice(1);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "bad_call" }, { status: 400 });
    }
    this.tables ??= sandboxTables(this.state.storage.sql);
    let answer;
    try {
      answer = serveSandbox(this.tables, op, body ?? {});
    } catch (error) {
      return Response.json({ error: "refused", message: String(error?.message ?? "refused").slice(0, 200) }, { status: 422 });
    }
    if (answer === null) return Response.json({ error: "unknown_op" }, { status: 400 });
    // Every use moves the expiry: 24 hours after the last one, the alarm deletes the whole test chat.
    if (op === "reset") await this.state.storage.deleteAlarm?.();
    else await this.state.storage.setAlarm(Date.now() + SANDBOX_TTL_MS);
    return Response.json(answer);
  }

  async alarm() {
    this.tables ??= sandboxTables(this.state.storage.sql);
    this.tables.wipe();
    await this.state.storage.deleteAll?.();
  }
}
