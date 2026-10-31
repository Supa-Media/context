/**
 * Tex's routine alarms, kept in a Durable Object's own SQLite beside its notes
 * (`texStore/objects.js`; decided by the owner, 2026-10-31:
 * `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * An alarm is an id, a time in milliseconds, and a payload the object hands
 * back when it is due. The payload is what the place that runs a routine needs
 * to find it again (a run id and a note's path). It never holds a grant or any
 * other credential: the object is not where those live (`docs/decisions/storage-and-credentials.md`).
 *
 * Pure over a `sql` with the Durable Object's shape (`exec(query, ...binds)`
 * returning a cursor with `toArray()`), so the Node tests run it against
 * `node:sqlite` and the Durable Object (`texStore.js`) runs it as it is. The
 * object owns the one runtime alarm and re-arms it from `nextAt` after each
 * change (`texStore.js`); nothing here touches the runtime.
 */

import { TexObjectRefused } from "./objects.js";

/** The most alarms one fire hands over; the rest wait for the next fire, as a batch. */
export const MAX_DUE = 50;
/** The most a payload may be, as JSON. A routine's is a path and a run id; this is generous. */
export const MAX_PAYLOAD_BYTES = 8 * 1024;
/** The longest id: a run's id plus a phone or a chat's key, with room to spare. */
export const MAX_ID_LENGTH = 256;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS alarms (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS alarms_at ON alarms (at, id)",
];

/** Each `sql` gets its table once; the statements are idempotent, but there is no need to repeat them. */
const ready = new WeakSet();

function init(sql) {
  if (ready.has(sql)) return;
  for (const statement of SCHEMA) sql.exec(statement);
  ready.add(sql);
}

const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

function checkId(id) {
  if (typeof id !== "string" || id === "" || id.length > MAX_ID_LENGTH || id.includes("\0")) {
    throw new TexObjectRefused("not an alarm id this object keeps");
  }
  return id;
}

function checkAt(at) {
  if (!Number.isSafeInteger(at) || at < 0) throw new TexObjectRefused("an alarm's time is a whole number of milliseconds");
  return at;
}

function payloadJson(payload) {
  // `undefined` and functions have no JSON, and `JSON.stringify` says so by answering nothing; BigInt throws.
  let json;
  try {
    json = JSON.stringify(payload ?? null);
  } catch {
    throw new TexObjectRefused("an alarm's payload is JSON");
  }
  if (json === undefined) throw new TexObjectRefused("an alarm's payload is JSON");
  if (new TextEncoder().encode(json).byteLength > MAX_PAYLOAD_BYTES) throw new TexObjectRefused(`an alarm's payload is larger than ${MAX_PAYLOAD_BYTES} bytes`);
  return json;
}

/**
 * Sets the alarm `id` to fire at `at` with `payload`, replacing any alarm
 * already under that id. Returns `{id, at}`.
 */
export function schedule(sql, { id, at, payload } = {}) {
  init(sql);
  checkId(id);
  checkAt(at);
  const json = payloadJson(payload);
  sql.exec(
    "INSERT INTO alarms (id, at, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, payload = excluded.payload",
    id,
    at,
    json,
  );
  return { id, at };
}

/** Removes the alarm `id`; one that is not there is no error. */
export function cancel(sql, id) {
  init(sql);
  sql.exec("DELETE FROM alarms WHERE id = ?", checkId(id));
}

/**
 * Removes the alarm `id` only while it still fires at `at`, the time it was
 * handed out at: one rescheduled meanwhile is not the one that ran.
 */
export function settle(sql, id, at) {
  init(sql);
  sql.exec("DELETE FROM alarms WHERE id = ? AND at = ?", checkId(id), checkAt(at));
}

/**
 * Moves the alarm `id` to fire at `later`, only while it still fires at `at`
 * (as `settle`): a failed routine waits, unless someone has rescheduled it.
 */
export function retry(sql, { id, at }, later) {
  init(sql);
  sql.exec("UPDATE alarms SET at = ? WHERE id = ? AND at = ?", checkAt(later), checkId(id), checkAt(at));
}

/**
 * The alarms due by `now`, earliest first (ties by id), at most `limit` of
 * them: `[{id, at, payload}]` with the payload as it was given.
 */
export function due(sql, now, limit = MAX_DUE) {
  init(sql);
  const count = Math.min(MAX_DUE, Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_DUE);
  return rows(sql.exec("SELECT id, at, payload FROM alarms WHERE at <= ? ORDER BY at, id LIMIT ?", now, count)).map((row) => ({
    id: row.id,
    at: Number(row.at),
    payload: JSON.parse(row.payload),
  }));
}

/** The earliest time any alarm is set for, or `null` when none is. */
export function nextAt(sql) {
  init(sql);
  const row = rows(sql.exec("SELECT MIN(at) AS at FROM alarms"))[0];
  return row && row.at !== null && row.at !== undefined ? Number(row.at) : null;
}
