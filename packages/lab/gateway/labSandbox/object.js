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

import { texLedger } from "../fromGateway/texStore_ledger.js";
import { objectByName } from "../fromGateway/objectPlace.js";
import { JOB_OUT_PREFIX, serveJobOut } from "./jobBox.js";

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
  // `prod` is its own column: a row's JSON holds its steps, whose inputs may say anything (`"prod":true` included).
  "CREATE TABLE IF NOT EXISTS sb_rows (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, prod INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS sb_writes (seq INTEGER PRIMARY KEY, by_row TEXT, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sb_kv (seq INTEGER PRIMARY KEY, obj TEXT NOT NULL, key TEXT NOT NULL, by_row TEXT, gone INTEGER NOT NULL, meta TEXT, body BLOB)",
  "CREATE INDEX IF NOT EXISTS sb_kv_key ON sb_kv (obj, key, seq)",
  "CREATE TABLE IF NOT EXISTS sb_ledger (seq INTEGER PRIMARY KEY, by_row TEXT, entries TEXT NOT NULL)",
  // What a test turn's write tools made (`sandboxTools.js`): notes by workspace and path, newest record each, and the
  // pages and pictures served from here (`pages.js`), each by an id nobody can guess.
  "CREATE TABLE IF NOT EXISTS sb_notes (seq INTEGER PRIMARY KEY, by_row TEXT, ctx TEXT NOT NULL, path TEXT NOT NULL, gone INTEGER NOT NULL, adds INTEGER NOT NULL DEFAULT 0, body TEXT)",
  "CREATE INDEX IF NOT EXISTS sb_notes_path ON sb_notes (ctx, path, seq)",
  "CREATE TABLE IF NOT EXISTS sb_assets (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, by_row TEXT, kind TEXT NOT NULL, title TEXT, type TEXT NOT NULL, ref TEXT, body BLOB)",
];
/** Every table a test chat keeps: Reset and the alarm delete them all. */
const TABLES = ["sb_meta", "sb_rows", "sb_writes", "sb_kv", "sb_ledger", "sb_notes", "sb_assets"];
/** The largest note or asset a test turn keeps here (a Durable Object row holds 2 MB). */
export const MAX_NOTE_CHARS = 500_000;
export const MAX_ASSET_BYTES = 1_500_000;
export const MAX_NOTES = 500;
export const MAX_ASSETS = 100;

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
    const error = new Error(`lab sandbox ${op} failed (${response.status})${typeof said?.message === "string" ? `: ${said.message}` : ""}`);
    error.status = response.status;
    throw error;
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

/**
 * A test chat made before `sb_rows.prod` (it lives a day): the column added, and each row's set from what its own top
 * level says, once. Where the column is there already, the ALTER refuses and nothing is read.
 */
function addProdColumn(sql) {
  try {
    sql.exec("ALTER TABLE sb_rows ADD COLUMN prod INTEGER NOT NULL DEFAULT 0");
  } catch {
    return;
  }
  for (const row of all(sql.exec("SELECT id, data FROM sb_rows"))) {
    let prod = false;
    try {
      prod = JSON.parse(row.data)?.prod === true;
    } catch {
      prod = false;
    }
    if (prod) sql.exec("UPDATE sb_rows SET prod = 1 WHERE id = ?", row.id);
  }
}

/** The test chat's tables over one SQLite handle (the object's, or a test's). */
export function sandboxTables(sql, { now = Date.now } = {}) {
  for (const statement of SCHEMA) sql.exec(statement);
  addProdColumn(sql);
  const ledger = texLedger(sql, { now });
  const meta = () => Object.fromEntries(all(sql.exec("SELECT k, v FROM sb_meta")).map((row) => [row.k, JSON.parse(row.v)]));
  const setMeta = (k, v) => (v === undefined || v === null ? sql.exec("DELETE FROM sb_meta WHERE k = ?", k) : sql.exec("INSERT OR REPLACE INTO sb_meta (k, v) VALUES (?, ?)", k, JSON.stringify(v)));
  const rows = () => all(sql.exec("SELECT seq, data FROM sb_rows ORDER BY seq")).map((row) => JSON.parse(row.data));
  const writes = () => all(sql.exec("SELECT data FROM sb_writes ORDER BY seq")).map((row) => JSON.parse(row.data));
  /** The test chat's own rows (texts, tapbacks, Tex's replies): every row not from the real chat it started from. */
  const testRows = () => Number(all(sql.exec("SELECT COUNT(*) AS n FROM sb_rows WHERE prod = 0"))[0]?.n ?? 0);
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
      sql.exec("DELETE FROM sb_notes WHERE by_row = ?", id);
      sql.exec("DELETE FROM sb_assets WHERE by_row = ?", id);
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
      for (const table of TABLES) sql.exec(`DELETE FROM ${table}`);
      setMeta("chat", about);
      setMeta("createdAt", now());
      this.seed({ rows: start, history });
    },
    /**
     * More of the real chat a test chat starts from, oldest first after what is kept, before any test text: its rows,
     * and its history into the ledger, kept in pieces of `SEED_CHUNK`. Never capped.
     */
    seed({ rows: more = [], history = [] }) {
      if (testRows() > 0) throw new Error("seeded after a test text");
      let seq = nextSeq("sb_rows");
      for (const row of more) {
        sql.exec("INSERT OR IGNORE INTO sb_rows (seq, id, data, prod) VALUES (?, ?, ?, ?)", seq, row.id, JSON.stringify(row), row?.prod === true ? 1 : 0);
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
      if (testRows() >= MAX_ROWS) throw new Error("full");
      sql.exec("INSERT INTO sb_rows (seq, id, data, prod) VALUES (?, ?, ?, ?)", nextSeq("sb_rows"), row.id, JSON.stringify(row), row?.prod === true ? 1 : 0);
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
    /** A write, with its `id` (`w<n>`): the Lab's "N sandbox writes" names it by that. */
    addWrite(write) {
      if (all(sql.exec("SELECT COUNT(*) AS n FROM sb_writes"))[0]?.n >= MAX_WRITES) return null;
      const seq = nextSeq("sb_writes");
      const kept = { id: `w${seq}`, ...write };
      sql.exec("INSERT INTO sb_writes (seq, by_row, data) VALUES (?, ?, ?)", seq, write.by ?? null, JSON.stringify(kept));
      return kept.id;
    },
    /**
     * A note a test turn wrote in workspace `ctx` ("" the turn's own): its whole text, lines added to it (`adds`, a
     * `remember` on a note the real workspace holds), or deleted (`gone`).
     */
    notePut({ ctx = "", path, body = null, gone = false, adds = false, by = null }) {
      if (typeof path !== "string" || path === "" || path.length > 512) throw new Error("bad_path");
      if (typeof body === "string" && body.length > MAX_NOTE_CHARS) throw new Error("too_big");
      if (all(sql.exec("SELECT COUNT(*) AS n FROM sb_notes"))[0]?.n >= MAX_NOTES) throw new Error("full");
      sql.exec("INSERT INTO sb_notes (seq, by_row, ctx, path, gone, adds, body) VALUES (?, ?, ?, ?, ?, ?, ?)", nextSeq("sb_notes"), by, String(ctx), path, gone ? 1 : 0, adds && !gone ? 1 : 0, gone ? null : String(body ?? ""));
    },
    /**
     * A note as the test chat has it: `{ path, gone, body, adds }`, `body` the last whole text written here (null when
     * only lines were added to the real note) and `adds` the lines added since; null when no test turn wrote it.
     */
    noteGet({ ctx = "", path }) {
      const rows = all(sql.exec("SELECT gone, adds, body FROM sb_notes WHERE ctx = ? AND path = ? ORDER BY seq", String(ctx), String(path)));
      if (rows.length === 0) return null;
      let note = { path: String(path), gone: false, body: null, adds: [] };
      for (const row of rows) {
        if (Number(row.gone) === 1) note = { path: String(path), gone: true, body: null, adds: [] };
        else if (Number(row.adds) === 1) note = { ...note, gone: false, adds: [...note.adds, row.body ?? ""] };
        else note = { path: String(path), gone: false, body: row.body ?? "", adds: [] };
      }
      return note;
    },
    /** Every note a test turn wrote in `ctx`, as `noteGet` has each, deleted ones left out. */
    noteList({ ctx = "" }) {
      const paths = [...new Set(all(sql.exec("SELECT path FROM sb_notes WHERE ctx = ? ORDER BY seq", String(ctx))).map((row) => row.path))];
      return paths.map((path) => this.noteGet({ ctx, path })).filter((note) => note && !note.gone);
    },
    /** A page or picture served from here (`pages.js`): its id is the caller's, unguessable, made once. */
    assetPut({ id, kind, title = "", type, ref = null, body = "", by = null }) {
      if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw new Error("bad_id");
      const bytes = unb64(body);
      if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error("too_big");
      if (all(sql.exec("SELECT COUNT(*) AS n FROM sb_assets"))[0]?.n >= MAX_ASSETS) throw new Error("full");
      sql.exec("INSERT OR REPLACE INTO sb_assets (seq, id, by_row, kind, title, type, ref, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", nextSeq("sb_assets"), id, by, String(kind), String(title).slice(0, 200), String(type).slice(0, 80), ref, bytes);
    },
    assetGet(id) {
      const row = all(sql.exec("SELECT id, kind, title, type, ref, body FROM sb_assets WHERE id = ?", String(id)))[0];
      return row ? { id: row.id, kind: row.kind, title: row.title ?? "", type: row.type, ref: row.ref ?? null, body: b64(toBytes(row.body)) } : null;
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
      for (const table of TABLES) sql.exec(`DELETE FROM ${table}`);
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
      return { ok: true, id: tables.addWrite(body.write) };
    case "note.put":
      tables.notePut(body);
      return { ok: true };
    case "note.get":
      return { found: tables.noteGet(body) };
    case "note.list":
      return { notes: tables.noteList(body) };
    case "asset.put":
      tables.assetPut(body);
      return { ok: true };
    case "asset.get":
      return { found: tables.assetGet(body.id) };
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
    case "claim": {
      // The one text running here, taken in one step (an object runs one call at a time): a fresh mark holds, a mark
      // nobody has refreshed for `staleMs` is a turn that died and is taken over.
      if (typeof body.msgId !== "string" || !Number.isFinite(body.staleMs)) throw new Error("claim names msgId and staleMs");
      const running = tables.meta().running;
      if (running && typeof running === "object" && Date.now() - Number(running.at ?? 0) < body.staleMs) return { ok: false, running: running.msgId ?? null };
      tables.setMeta("running", { msgId: body.msgId, node: null, at: Date.now() });
      return { ok: true };
    }
    case "beat": {
      // The running text's steps so far, and proof it is alive; never another text's mark.
      const running = tables.meta().running;
      if (running?.msgId !== body.msgId) return { ok: false };
      tables.setMeta("running", { msgId: body.msgId, node: body.node ?? null, at: Date.now(), ...(Array.isArray(body.steps) ? { steps: body.steps } : {}) });
      return { ok: true };
    }
    case "alive": {
      // A run the object keeps (`crossRuns.js` `objectRun`) calling itself, so the object is never idle mid-model-call;
      // its mark is kept fresh as it stands, its node and steps untouched. Never another text's mark.
      const running = tables.meta().running;
      if (running?.msgId !== body.msgId) return { ok: false };
      tables.setMeta("running", { ...running, at: Date.now() });
      return { ok: true };
    }
    case "release": {
      const running = tables.meta().running;
      if (running?.msgId !== body.msgId) return { ok: false };
      tables.setMeta("running", null);
      return { ok: true };
    }
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

/** What an object with no test chat in it answers: opening one, reading it, and the person's index's send count. */
const CHATLESS_OPS = new Set(["init", "state", "count"]);
/** The person's index object's own keys (`route.js`: `sb:<id>` a test chat listed, `used:<id>` its last use). */
const INDEX_KEY = /^(sb|used):[0-9a-f]{16}$/;

/** Whether storage holds a test chat, read without making anything. */
function chatKept(sql) {
  if (all(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sb_meta'")).length === 0) return false;
  return all(sql.exec("SELECT k FROM sb_meta WHERE k = 'chat'")).length > 0;
}

/**
 * What `cross.carry` and `text.run` run (`crossRuns.js` `objectCarry`, `objectRun`; `op` says which), handed in by the
 * route when the Worker loads it
 * (`carryWith`): the route and the turn import this file, and the control plane's reads of it stay this file's own.
 * Unset, the object says it carries nothing and the request carries the trip.
 */
let carryHere = null;
export function carryWith(carry) {
  carryHere = typeof carry === "function" ? carry : null;
}

/** The Durable Object class (`LabSandbox` in `wrangler.toml`). */
export class LabSandboxObject {
  /** `carry` is what `cross.carry` and `text.run` run; only a test hands its own. */
  constructor(state, env, { carry = null } = {}) {
    this.state = state;
    this.env = env;
    this.carry = carry;
    this.tables = null;
  }

  async fetch(request) {
    // A test chat's job box calling out (`jobBox.js`): answered on the fences of the run that started it, any method.
    if (new URL(request.url).pathname.startsWith(JOB_OUT_PREFIX)) return await serveJobOut(request);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const op = new URL(request.url).pathname.slice(1);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "bad_call" }, { status: 400 });
    }
    // Whether this is a test chat, read without making a table or arming the alarm: an address nobody opened stays empty.
    if (op === "exists") return Response.json({ exists: chatKept(this.state.storage.sql) });
    this.tables ??= sandboxTables(this.state.storage.sql);
    // A test chat that is gone (Reset, or never opened) answers only what opens one, and its person's own index: a turn
    // still running when it was reset is refused here, so it writes nothing and arms nothing (`harness.js` `cancelled`).
    if (!CHATLESS_OPS.has(op) && !(op === "meta" && INDEX_KEY.test(String(body?.key ?? ""))) && !this.tables.meta().chat) {
      return Response.json({ error: "gone", message: "This test chat is gone (Reset, or a day unused)." }, { status: 410 });
    }
    // A turn's asks of other chats, carried here so they outlive the request that sent the text (`crossRuns.js`).
    // A test row's whole run (its turn, its jobs, its asks), likewise (`crossRuns.js` `objectRun`).
    if (op === "cross.carry" || op === "text.run") return Response.json((this.carry ?? carryHere)?.(this.env, this.state, body, op) ?? (op === "text.run" ? { running: false } : { carrying: false }));
    let answer;
    try {
      answer = serveSandbox(this.tables, op, body ?? {});
    } catch (error) {
      return Response.json({ error: "refused", message: String(error?.message ?? "refused").slice(0, 200) }, { status: 422 });
    }
    if (answer === null) return Response.json({ error: "unknown_op" }, { status: 400 });
    // Every use moves the expiry: 24 hours after the last one, the alarm deletes the whole test chat.
    // Only a test chat, or the person's index, is kept for a day: a read of an object with neither arms nothing.
    if (op === "reset") await this.state.storage.deleteAlarm?.();
    else if (op !== "state" || this.tables.meta().chat) await this.state.storage.setAlarm(Date.now() + SANDBOX_TTL_MS);
    return Response.json(answer);
  }

  async alarm() {
    this.tables ??= sandboxTables(this.state.storage.sql);
    this.tables.wipe();
    await this.state.storage.deleteAll?.();
  }
}
