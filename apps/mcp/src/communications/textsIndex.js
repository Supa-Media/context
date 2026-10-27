/**
 * The Messages backup's index: the records under `.context/messages/imessage/`
 * folded into the context's own search database, so "what did my sister text
 * me about the flight" is one query rather than a walk of the bucket
 * (`docs/decisions/communications/messages-backup.md`).
 *
 * ## A disposable derivative
 *
 * Every row is rebuilt from the bucket (`textsCatchUp`), and dropping the
 * tables loses nothing. It lives in the per-context database, never a shared
 * one, for the reason the notes table does: one database per context is the
 * tenancy boundary. Where a context has no database (a self-host without
 * fast search) there is no index, and the texts tools say so.
 *
 * ## Later wins, whatever order rows arrive in
 *
 * A row carries the batch it came from (`seq`, which begins with the time the
 * batch arrived). An upsert replaces a row only with one from the same or a
 * later batch, so the write path, a catch-up pass and a rebuild can run in any
 * order and land on what a fold of the log in arrival order gives.
 *
 * ## Never missed
 *
 * A batch is projected as it is written. When that cannot happen (no database
 * yet, the database down) the gateway leaves a marker under `pending/`, and
 * the next read projects what the markers name before answering. A database
 * that has never been filled (`texts_ready` unset) is filled by a walk of the
 * whole log, a few objects a read, from where the last read stopped.
 *
 * Every value reaches SQL through a placeholder; a batch travels as one JSON
 * parameter read back with `json_each`.
 */

import { BACKUP_PREFIX, recordKey } from "../../../../packages/communications/src/backup.js";
import { createD1Client } from "../search/d1/client.js";

export const TEXTS_LOG = `${BACKUP_PREFIX}log/`;
export const TEXTS_PENDING = `${BACKUP_PREFIX}pending/`;

export const TEXTS_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS texts_records (
     key    TEXT PRIMARY KEY,
     kind   TEXT NOT NULL,
     seq    TEXT NOT NULL,
     chat   TEXT,
     at     INTEGER,
     handle TEXT,
     words  TEXT NOT NULL,
     body   TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS texts_by_chat_at ON texts_records (chat, at)",
  "CREATE INDEX IF NOT EXISTS texts_by_kind ON texts_records (kind, handle)",
  "CREATE VIRTUAL TABLE IF NOT EXISTS texts_fts USING fts5(key UNINDEXED, words)",
  `CREATE TABLE IF NOT EXISTS index_state (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
]);

/** `index_state` keys, prefixed so they cannot collide with the search, tree or history state. */
export const TEXTS_STATE = Object.freeze({
  /** Set once the whole log has been walked into this database. */
  ready: "texts_ready",
  /** The last log key a walk projected, while it is under way. */
  walkAfter: "texts_walk_after",
});

/** Rows one statement's JSON parameter carries. */
const WRITE_ROWS = 300;
/** Log objects one read may project before it answers. */
export const CATCH_UP_OBJECTS = 20;

/** This context's database, or null where it has none. */
export function textsClientOf(store) {
  const descriptor = store?.searchIndex;
  if (!descriptor || typeof descriptor !== "object") return null;
  try {
    return createD1Client(descriptor);
  } catch {
    return null;
  }
}

function chunks(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

function ensureStatements() {
  return TEXTS_STATEMENTS.map((sql) => ({ sql, params: [] }));
}

/** A normalized record as a row: [key, kind, seq, chat, at, handle, words, body]. */
export function rowOf(record, seq) {
  const at = typeof record.at === "string" ? Date.parse(record.at) : null;
  switch (record.kind) {
    case "message":
      return [recordKey(record), "message", seq, record.chat, at, record.me ? null : record.from ?? null, record.text, JSON.stringify(record)];
    case "reaction":
      return [recordKey(record), "reaction", seq, record.chat, at, record.me ? null : record.from ?? null, "", JSON.stringify(record)];
    case "chat":
      return [recordKey(record), "chat", seq, record.id, null, null, record.name ?? "", JSON.stringify(record)];
    case "person":
      return [recordKey(record), "person", seq, null, null, record.handle, record.name, JSON.stringify(record)];
    default:
      return null;
  }
}

const COLUMNS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `json_extract(j.value, '$[${i}]')`).join(", ");

/** Upsert rows, later batch winning, then rebuild each touched key's words in the full-text table. */
export function upsertStatements(rows) {
  const statements = [];
  for (const group of chunks(rows.filter((row) => row !== null), WRITE_ROWS)) {
    const json = JSON.stringify(group);
    const keys = JSON.stringify(group.map((row) => row[0]));
    statements.push(
      {
        sql: `INSERT INTO texts_records (key, kind, seq, chat, at, handle, words, body)
              SELECT ${COLUMNS} FROM json_each(?1) AS j WHERE true
              ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, seq = excluded.seq, chat = excluded.chat,
                at = excluded.at, handle = excluded.handle, words = excluded.words, body = excluded.body
              WHERE excluded.seq >= texts_records.seq`,
        params: [json],
      },
      { sql: "DELETE FROM texts_fts WHERE key IN (SELECT value FROM json_each(?1))", params: [keys] },
      {
        sql: `INSERT INTO texts_fts (key, words)
              SELECT r.key, r.words FROM texts_records AS r
              WHERE r.key IN (SELECT value FROM json_each(?1)) AND r.kind = 'message' AND r.words <> ''`,
        params: [keys],
      },
    );
  }
  return statements;
}

/** The records of one log object, as rows. Lines that are not records are skipped. */
export function rowsOfObject(key, text) {
  const seq = key.slice(key.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line) continue;
    try {
      const row = rowOf(JSON.parse(line), seq);
      if (row !== null) rows.push(row);
    } catch {
      // A line that is not JSON is not a record.
    }
  }
  return rows;
}

async function readText(store, key) {
  const object = await store.get(key);
  if (!object) return null;
  return typeof object.text === "function" ? await object.text() : typeof object.body === "string" ? object.body : null;
}

/** The marker a batch leaves when it could not be projected as it was written. */
export function pendingKeyOf(logKey) {
  return `${TEXTS_PENDING}${logKey.slice(TEXTS_LOG.length)}`;
}

/**
 * Project one batch as it is written: `objects` is `[logKey, records]` for each
 * object the batch wrote. On any failure, markers are left for the next read.
 */
export async function projectBatch(store, objects) {
  const client = textsClientOf(store);
  const rows = objects.flatMap(([key, records]) => {
    const seq = key.slice(key.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
    return records.map((record) => rowOf(record, seq));
  });
  try {
    if (client === null) throw new Error("no database");
    await client.runAll([...ensureStatements(), ...upsertStatements(rows)]);
  } catch {
    for (const [key] of objects) {
      try {
        await store.put(pendingKeyOf(key), "");
      } catch {
        // A rebuild (`texts_ready` unset) walks the whole log in any case.
      }
    }
  }
}

async function readState(client) {
  const rows = await client.query("SELECT key, value FROM index_state WHERE key IN (?1, ?2)", [TEXTS_STATE.ready, TEXTS_STATE.walkAfter]);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function setState(key, value) {
  return value === null
    ? { sql: "DELETE FROM index_state WHERE key = ?1", params: [key] }
    : { sql: "INSERT INTO index_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params: [key, String(value)] };
}

/**
 * Bring the index up to the log, a bounded amount at a time. Answers
 * `{ ok, complete }`: `complete` is false while a first walk is under way,
 * so an answer can say that older texts are still being indexed.
 */
export async function textsCatchUp(store, client, { most = CATCH_UP_OBJECTS } = {}) {
  await client.runAll(ensureStatements());
  let budget = most;

  // Markers first: a batch the write path could not project.
  const pending = await store.list({ prefix: TEXTS_PENDING, limit: budget });
  for (const object of pending?.objects ?? []) {
    const logKey = `${TEXTS_LOG}${object.key.slice(TEXTS_PENDING.length)}`;
    const text = await readText(store, logKey);
    if (text !== null) await client.runAll(upsertStatements(rowsOfObject(logKey, text)));
    await store.delete(object.key);
    budget -= 1;
  }

  const state = await readState(client);
  if (state[TEXTS_STATE.ready]) return { ok: true, complete: true };
  if (budget <= 0) return { ok: true, complete: false };

  const page = await store.list({ prefix: TEXTS_LOG, limit: budget, ...(state[TEXTS_STATE.walkAfter] ? { startAfter: state[TEXTS_STATE.walkAfter] } : {}) });
  const objects = page?.objects ?? [];
  let last = state[TEXTS_STATE.walkAfter] ?? null;
  for (const object of objects) {
    const text = await readText(store, object.key);
    if (text !== null) await client.runAll(upsertStatements(rowsOfObject(object.key, text)));
    last = object.key;
  }
  const done = !page?.truncated || objects.length === 0;
  await client.runAll(
    done ? [setState(TEXTS_STATE.ready, Date.now()), setState(TEXTS_STATE.walkAfter, null)] : [setState(TEXTS_STATE.walkAfter, last)],
  );
  return { ok: true, complete: done };
}
