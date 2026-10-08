/**
 * The tree table: every key in a context's bucket, kept in that context's own
 * search database, so a tree can be drawn without walking the bucket.
 *
 * ## Why it exists
 *
 * A bucket has no folders and no rename. Listing one folder is a walk of
 * every key under it, a thousand at a time, and drawing a whole tree is a walk
 * of the whole bucket: @seyi (9,129 notes) took three or more sequential
 * 4,000-entry manifest calls, each several list requests, before the side
 * panel could draw (2026-10-08). A row per key in a database answers the same
 * question in one query of a few hundred milliseconds at any size, which is
 * what makes a sidebar instant for 100,000 notes.
 *
 * ## What it holds, and what it never decides
 *
 * Keys, versions, sizes and times. **No note text**, and no visibility: who
 * may see a row is decided when it is served, by the same `canSee` over the
 * live `privacy.md` that every listing applies (`source.js` hands these rows
 * to the unchanged `syncManifest`). So a stale row can show a note that has
 * just moved, never one the reader may not see.
 *
 * It is a disposable derivative (CLAUDE.md, "Plain files stay canonical"):
 * the bucket is the truth, a sweep rebuilds the table from it, and deleting
 * the database loses nothing. It lives in the per-context search database,
 * never a shared one, for the reason the notes table does: one database per
 * context is the tenancy boundary.
 *
 * Top-level dot folders (`.context/`, `.obsidian/`) are left out. Nothing
 * under one is ever an entry or a folder of a tree (`syncManifest` steps over
 * them), and `.context/reads/` alone grows by one object per AI read.
 *
 * ## Staying true: last observation wins
 *
 * Two writers keep it current: a sweep that lists the bucket (`sweep.js`) and
 * the write path, which re-checks what a change touched (`touch.js`). They can
 * race, so every row carries `at`, the time the bucket was observed to hold
 * it, and every write keeps whichever observation is newer:
 *
 *  - an upsert never overwrites a row observed later than it;
 *  - a key seen gone leaves a tombstone in `tree_gone`, and an upsert of that
 *    key from an observation made before it was seen gone is dropped, so a
 *    sweep that listed a note a moment before it was deleted cannot bring it
 *    back;
 *  - a completed sweep deletes every row nobody has observed since the sweep
 *    began, which is how a key deleted outside the product leaves.
 *
 * Every value reaches SQL through a placeholder. Batches travel as one JSON
 * parameter read back with `json_each`, because D1 binds at most a hundred
 * parameters to a statement.
 */

/** The tables. Created by the first sweep, so an existing database needs no migration step. */
export const TREE_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS tree (
     path     TEXT PRIMARY KEY,
     etag     TEXT,
     size     INTEGER,
     uploaded INTEGER,
     at       INTEGER NOT NULL
   ) WITHOUT ROWID`,
  // "What changed since my last sync" is a range over `at`, for the apps' copies.
  "CREATE INDEX IF NOT EXISTS tree_by_at ON tree (at)",
  `CREATE TABLE IF NOT EXISTS tree_gone (
     path TEXT PRIMARY KEY,
     at   INTEGER NOT NULL
   ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS tree_gone_by_at ON tree_gone (at)",
  `CREATE TABLE IF NOT EXISTS index_state (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
]);

/** `index_state` keys, all prefixed so they cannot collide with the search backfill's. */
export const TREE_STATE = Object.freeze({
  /** A sweep has finished at least once: the table describes the whole bucket. */
  ready: "tree_ready",
  /** When the last sweep finished, epoch ms. */
  sweptAt: "tree_swept_at",
  /** The sweep in progress: the last key it listed (`""` at its start). Absent when none is. */
  cursor: "tree_cursor",
  /** When the sweep in progress began, epoch ms. */
  startedAt: "tree_started_at",
  /** When a sweep pass last ran, epoch ms: a lease, so two passes do not walk at once. */
  leaseAt: "tree_lease_at",
  /** A change was too large to re-check key by key: the next read should start a sweep. */
  dirty: "tree_dirty",
  /** This store cannot resume a listing in key order, so the table is never served. */
  unsupported: "tree_unsupported",
});

/** Rows one read returns. Small enough that a page of long paths stays far under a 1MB response. */
export const TREE_PAGE_ROWS = 2_000;

/** Rows one upsert carries in its JSON parameter. */
export const TREE_WRITE_ROWS = 500;

/**
 * How long a tombstone outlives the deletion it records. Far longer than any
 * pass could race it, because the tombstones are also how a device that was
 * offline learns what was deleted while it was away: one back within this
 * window asks for the changes since its last sync, and one away longer reads
 * the whole table again.
 */
export const TOMBSTONE_MS = 30 * 24 * 60 * 60_000;

/** The top-level dot folder a key lives under, or null: everything under one is plumbing. */
export function plumbingRoot(key) {
  const slash = key.indexOf("/");
  if (slash <= 1 || !key.startsWith(".")) return null;
  return key.slice(0, slash);
}

/**
 * The first key after everything that starts with `prefix`, for a prefix that
 * ends in `/`: `/` is followed by `0` in byte order. `null` for the whole bucket.
 */
export function prefixEnd(prefix) {
  if (prefix === "") return null;
  if (!prefix.endsWith("/")) throw new Error("tree prefix must end in /");
  return `${prefix.slice(0, -1)}0`;
}

function chunks(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

/** A listed object as a row, or null for one the table does not keep. */
export function rowOf(object) {
  const key = object?.key;
  if (typeof key !== "string" || key === "" || plumbingRoot(key) !== null) return null;
  const uploaded = object.uploaded === undefined || object.uploaded === null
    ? null
    : new Date(object.uploaded).getTime();
  return [
    key,
    typeof object.etag === "string" && object.etag !== "" ? object.etag : null,
    Number.isFinite(object.size) ? object.size : null,
    Number.isFinite(uploaded) ? uploaded : null,
  ];
}

/**
 * Upserts for rows the bucket was observed to hold at `at`. A row observed
 * later, or a key seen gone later, wins.
 *
 * An unknown size or time keeps the one already recorded. An unknown `etag`
 * does not: a missing version means "read it to learn", and keeping an old one
 * would tell a device's copy that a changed note is unchanged.
 */
export function observeStatements(rows, at) {
  return chunks(rows, TREE_WRITE_ROWS).map((group) => ({
    sql: `INSERT INTO tree (path, etag, size, uploaded, at)
          SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'),
                 json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), ?1
          FROM json_each(?2) AS j
          WHERE NOT EXISTS (
            SELECT 1 FROM tree_gone AS g WHERE g.path = json_extract(j.value, '$[0]') AND g.at > ?1
          )
          ON CONFLICT(path) DO UPDATE SET
            etag = CASE WHEN excluded.at >= tree.at THEN excluded.etag ELSE tree.etag END,
            size = CASE WHEN excluded.at >= tree.at THEN coalesce(excluded.size, tree.size) ELSE tree.size END,
            uploaded = CASE WHEN excluded.at >= tree.at THEN coalesce(excluded.uploaded, tree.uploaded) ELSE tree.uploaded END,
            at = max(tree.at, excluded.at)`,
    params: [at, JSON.stringify(group)],
  }));
}

/** Keys observed absent at `at`: tombstoned, and their rows removed unless observed since. */
export function goneStatements(paths, at) {
  return chunks(paths, TREE_WRITE_ROWS).flatMap((group) => {
    const json = JSON.stringify(group);
    return [
      {
        sql: `INSERT INTO tree_gone (path, at) SELECT j.value, ?1 FROM json_each(?2) AS j WHERE true
              ON CONFLICT(path) DO UPDATE SET at = max(tree_gone.at, excluded.at)`,
        params: [at, json],
      },
      {
        sql: `DELETE FROM tree WHERE path IN (SELECT j.value FROM json_each(?2) AS j) AND at <= ?1`,
        params: [at, json],
      },
    ];
  });
}

/**
 * Every row under `prefix` (the whole table for `""`) that nobody has observed
 * since `since`, tombstoned and removed: what a complete listing that began at
 * `since` did not find.
 */
export function vanishedStatements(prefix, since) {
  const end = prefixEnd(prefix);
  const range = end === null ? "path >= ?2" : "path >= ?2 AND path < ?3";
  const params = end === null ? [since, prefix] : [since, prefix, end];
  return [
    {
      sql: `INSERT INTO tree_gone (path, at) SELECT path, ?1 FROM tree WHERE ${range} AND at < ?1 AND true
            ON CONFLICT(path) DO UPDATE SET at = max(tree_gone.at, excluded.at)`,
      params,
    },
    { sql: `DELETE FROM tree WHERE ${range} AND at < ?1`, params },
  ];
}

/** Tombstones old enough that no pass still running could be racing them. */
export function pruneStatements(now) {
  return [{ sql: "DELETE FROM tree_gone WHERE at < ?1", params: [now - TOMBSTONE_MS] }];
}

export function setStateStatements(entries) {
  return Object.entries(entries).map(([key, value]) =>
    value === null
      ? { sql: "DELETE FROM index_state WHERE key = ?1", params: [key] }
      : {
          sql: `INSERT INTO index_state (key, value) VALUES (?1, ?2)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          params: [key, String(value)],
        },
  );
}

export async function ensureTreeTables(client) {
  await client.runAll(TREE_STATEMENTS.map((sql) => ({ sql, params: [] })));
}

/**
 * What the table can be trusted for. A database with no tree table yet reads
 * as never swept, which is what it is.
 */
export async function readTreeState(client) {
  let rows;
  try {
    rows = await client.query("SELECT key, value FROM index_state WHERE key LIKE 'tree_%'");
  } catch (error) {
    if (/no such table/i.test(String(error?.message ?? ""))) rows = [];
    else throw error;
  }
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const number = (key) => {
    const value = Number(values.get(key));
    return values.has(key) && Number.isFinite(value) ? value : null;
  };
  return {
    ready: values.get(TREE_STATE.ready) === "1",
    sweptAt: number(TREE_STATE.sweptAt),
    cursor: values.has(TREE_STATE.cursor) ? values.get(TREE_STATE.cursor) : null,
    startedAt: number(TREE_STATE.startedAt),
    leaseAt: number(TREE_STATE.leaseAt),
    dirty: values.get(TREE_STATE.dirty) === "1",
    unsupported: values.get(TREE_STATE.unsupported) === "1",
  };
}

/**
 * One page of rows in key order: those under `prefix`, after `after`.
 * SQLite compares text bytewise, which is S3's UTF-8 byte order, so a walk of
 * this table resumes exactly where a walk of the bucket would.
 */
export async function listTreePage(client, { prefix = "", after, limit = TREE_PAGE_ROWS }) {
  const end = prefixEnd(prefix);
  const conditions = ["path >= ?1"];
  const params = [prefix];
  if (end !== null) {
    params.push(end);
    conditions.push(`path < ?${params.length}`);
  }
  if (typeof after === "string" && after !== "") {
    params.push(after);
    conditions.push(`path > ?${params.length}`);
  }
  params.push(Math.max(1, Math.min(limit, TREE_PAGE_ROWS)));
  return await client.query(
    `SELECT path, etag, size, uploaded FROM tree WHERE ${conditions.join(" AND ")}
     ORDER BY path LIMIT ?${params.length}`,
    params,
  );
}
