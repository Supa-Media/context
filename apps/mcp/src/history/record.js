/**
 * The write path's half of keeping the history table current: a stored read
 * becomes a row as it is stored, and a rewrite of `activity.md` is mirrored as
 * it lands.
 *
 * Both run behind the response and never throw. The read or the change has
 * already landed in the bucket, which is the record; the table is a
 * derivative, and what this misses the serve path repairs — it compares
 * `activity.md`'s version on every replay (`serve.js`), and a read whose row
 * failed marks its day to be read again (`recheckFrom`).
 */

import {
  HISTORY_STATE,
  ensureStatements,
  historyClientOf,
  insertStatements,
  lowerStatement,
  mirrorStatements,
  readRow,
} from "./table.js";

const DAY_MS = 24 * 60 * 60_000;

/** One read, as its object was just stored. `record` is `readRecordOf`'s. */
export async function keepHistoryRead(store, key, record) {
  const client = historyClientOf(store);
  if (client === null || record === null) return;
  const row = readRow(key, record);
  if (row === null) return;
  try {
    await client.runAll([...ensureStatements(), ...insertStatements([row])]);
  } catch {
    try {
      await client.runAll([lowerStatement(HISTORY_STATE.recheckFrom, Math.floor(record.at / DAY_MS) * DAY_MS)]);
    } catch {
      // The database is down; the read is in the bucket all the same.
    }
  }
}

/** `activity.md`'s lines as just written, and the version the store answered with. */
export async function keepHistoryActivity(store, entries, etag) {
  const client = historyClientOf(store);
  if (client === null) return;
  try {
    await client.runAll([...ensureStatements(), ...mirrorStatements(entries, { etag })]);
  } catch {
    // The next replay sees the file's version differ and mirrors it then.
  }
}

/** `keepHistoryActivity`, behind the response where the host allows it, and never in front. */
export function keepHistoryActivityLater(store, entries, etag) {
  if (historyClientOf(store) === null || typeof store.defer !== "function") return;
  try {
    store.defer(keepHistoryActivity(store, entries, etag));
  } catch {
    // A host whose `waitUntil` refuses the work simply does not mirror.
  }
}
