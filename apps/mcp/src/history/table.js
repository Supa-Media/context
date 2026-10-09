/**
 * The history table: what happened in a context — the lines of `activity.md`,
 * the change records under `.context/audit/` that fell off its end, and the
 * reads under `.context/reads/` — kept in that context's own search database
 * so a replay is one query rather than a walk of the bucket.
 *
 * ## Why it exists
 *
 * A replay used to cost a control-plane round trip that read `activity.md`
 * (400 lines, so a busy week was cut short), then a grant, then a gateway ask
 * that walked `.context/reads/` one UTC day at a time, eight days at most.
 * Rows here answer any span in one query.
 *
 * ## What it holds, and what it never decides
 *
 * Times, kinds, paths, who (`by`, `via`, as `activity.md` and the stored reads
 * name a hand) and the event-time visibility flag. **Never note text**, and no
 * line's summary: a summary is an AI's prose about a note. Who may see a row is
 * decided when it is served (`serve.js`), by the same filters the bucket's own
 * history is served through — `visibleEntries` with forwarding for a line,
 * `readFilterFor` for a read — so a stale row can be late, never visible to
 * somebody the live manifest holds it back from.
 *
 * It is a disposable derivative (CLAUDE.md, "Plain files stay canonical"):
 * every row is rebuilt from the bucket by `backfill.js`, and deleting the
 * database loses nothing. It lives in the per-context database, never a shared
 * one, for the reason the notes and tree tables do: one database per context
 * is the tenancy boundary.
 *
 * ## Three sources, one row shape
 *
 *  - `activity`: a line of `activity.md`, mirrored. A line changes while it is
 *    near the top of the file (a merge moves it and rewrites its time), so the
 *    mirror deletes every activity row from the file's oldest line onward and
 *    writes the file's lines again. Lines that fell off the file's end stay.
 *  - `audit`: one change record, only from before the first mirror began
 *    (`activityFrom`) — after that, the file already says it. Built with the
 *    file's own `entryFor`, so the substance rules are the file's.
 *  - `read`: one stored read, keyed by its object's key.
 *
 * Every value reaches SQL through a placeholder; a batch travels as one JSON
 * parameter read back with `json_each` (D1 binds at most a hundred).
 */

import { MAX_ENTRIES } from "../../../../packages/shared/src/activity.cjs";
import { createD1Client } from "../search/d1/client.js";

/** The tables. Created by the first write or pass, so an existing database needs no migration. */
export const HISTORY_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS history_events (
     id     TEXT PRIMARY KEY,
     at     INTEGER NOT NULL,
     source TEXT NOT NULL,
     kind   TEXT NOT NULL,
     paths  TEXT NOT NULL,
     moves  TEXT,
     n      INTEGER NOT NULL,
     tool   TEXT,
     by     TEXT,
     via    TEXT,
     agent  INTEGER NOT NULL,
     team   INTEGER NOT NULL
   ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS history_events_by_at ON history_events (at, id)",
  `CREATE TABLE IF NOT EXISTS index_state (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
]);

/** `index_state` keys, prefixed so they cannot collide with the search or tree state. */
export const HISTORY_STATE = Object.freeze({
  /** Audit records are rows only before this, epoch ms: from here on `activity.md` says it. */
  activityFrom: "history_activity_from",
  /** Where the last mirror's lines began, epoch ms. */
  mirrorFrom: "history_mirror_from",
  /** The `activity.md` version last mirrored. */
  mirrorEtag: "history_mirror_etag",
  /** Every stored read at or after this UTC day start is a row, epoch ms. */
  readsFrom: "history_reads_from",
  /** Every audit record whose key sorts at or after this is a row (or was not one to keep). */
  auditBelow: "history_audit_below",
  /** The earliest UTC day any read was stored on, epoch ms, or `none`. */
  readsFloor: "history_reads_floor",
  /** The earliest audit record's time, epoch ms, or `none`. */
  auditFloor: "history_audit_floor",
  /** Whether legacy `.audit/` holds anything: `1` or `0`. */
  legacyAudit: "history_legacy_audit",
  /** A write of a read failed from this UTC day start: the next pass reads those days again. */
  recheckFrom: "history_recheck_from",
  /** When the recent days' reads were last compared with the bucket, epoch ms. */
  verifiedAt: "history_verified_at",
});

/** Rows one statement's JSON parameter carries. */
export const HISTORY_WRITE_ROWS = 400;

/** Rows one read returns. A row is a few hundred bytes; D1's answer is capped at 1MB here. */
export const HISTORY_PAGE_ROWS = 1_500;

/** This context's database, or null where it has none (fast search off, a self-host). */
export function historyClientOf(store) {
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

/** The tables first, as every writer sends them: a database made before them has them after. */
export function ensureStatements() {
  return HISTORY_STATEMENTS.map((sql) => ({ sql, params: [] }));
}

/**
 * A line (from the file, or built from an audit record by `entryFor`) as a
 * row. The summary (`note`) is left behind on purpose: see the header.
 */
export function lineRow(entry, { id, source, agent = false }) {
  const at = Date.parse(entry?.at);
  if (!Number.isFinite(at) || typeof entry.kind !== "string") return null;
  const paths = Array.isArray(entry.paths) ? entry.paths.filter((path) => typeof path === "string" && path) : [];
  if (paths.length === 0) return null;
  return [
    id,
    at,
    source,
    entry.kind,
    JSON.stringify(paths),
    Array.isArray(entry.moves) && entry.moves.length ? JSON.stringify(entry.moves) : null,
    Number.isFinite(entry.n) && entry.n > 0 ? Math.floor(entry.n) : 1,
    null,
    typeof entry.by === "string" ? entry.by : null,
    typeof entry.via === "string" ? entry.via : null,
    agent ? 1 : 0,
    entry.vis === "team" ? 1 : 0,
  ];
}

/** A stored read (as `readRecordOf` validated it) as a row. A stored read is always a tool's. */
export function readRow(key, record) {
  if (typeof key !== "string" || !key || !record || !Number.isFinite(record.at)) return null;
  return [
    key,
    record.at,
    "read",
    "read",
    JSON.stringify([record.path]),
    null,
    1,
    record.tool,
    record.by,
    record.via,
    1,
    record.teamVisible === true ? 1 : 0,
  ];
}

const INSERT_SELECT = `SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
         json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]'),
         json_extract(j.value, '$[6]'), json_extract(j.value, '$[7]'), json_extract(j.value, '$[8]'),
         json_extract(j.value, '$[9]'), json_extract(j.value, '$[10]'), json_extract(j.value, '$[11]')
  FROM json_each(?1) AS j WHERE true`;

/**
 * Rows that never change once written (a read, an audit record): a second
 * write of the same key is a no-op, so a pass and the write path can race.
 */
export function insertStatements(rows) {
  return chunks(rows.filter((row) => row !== null), HISTORY_WRITE_ROWS).map((group) => ({
    sql: `INSERT INTO history_events (id, at, source, kind, paths, moves, n, tool, by, via, agent, team)
          ${INSERT_SELECT}
          ON CONFLICT(id) DO NOTHING`,
    params: [JSON.stringify(group)],
  }));
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

/** Set once and never moved: the first answer wins. */
export function setOnceStatement(key, value) {
  return {
    sql: "INSERT INTO index_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
    params: [key, String(value)],
  };
}

/**
 * Coverage only ever widens (moves earlier), whichever of two racing passes
 * lands last: both wrote their rows before their state. Numbers compare as
 * numbers; audit keys as text, which SQLite compares bytewise, as S3 lists.
 */
export function lowerStatement(key, value, { numeric = true } = {}) {
  const merged = numeric
    ? "CAST(min(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)"
    : "min(value, excluded.value)";
  return {
    sql: `INSERT INTO index_state (key, value) VALUES (?1, ?2)
          ON CONFLICT(key) DO UPDATE SET value = ${merged}`,
    params: [key, String(value)],
  };
}

/**
 * Where the rows a mirror replaces begin: the file's oldest line, or — while
 * the file is under its cap, so nothing has fallen off its end since the last
 * mirror — that mirror's own start, because a short file's oldest line can
 * itself be the one a merge moved forward.
 */
export function mirrorFromOf(count, cutoff, previous) {
  if (cutoff === null) return null;
  if (count >= MAX_ENTRIES || previous === null || !Number.isFinite(previous)) return cutoff;
  return Math.min(cutoff, previous);
}

/**
 * `activity.md`'s lines as they are now: every activity row in the span the
 * file covers (`mirrorFromOf`) replaced by the file's lines, and the first
 * mirror's start remembered as the point audit records stop being needed.
 *
 * An empty or missing file deletes nothing — the rows are what it said, and
 * the audit trail still stands behind the gateway's half of them.
 */
export function mirrorStatements(entries, { etag = null, now = Date.now() } = {}) {
  const rows = [];
  let cutoff = null;
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    const row = lineRow(entry, { id: `activity:${entry?.at}:${index}`, source: "activity" });
    if (row === null) return;
    rows.push(row);
    cutoff = cutoff === null ? row[1] : Math.min(cutoff, row[1]);
  });
  const statements = [];
  if (cutoff !== null) {
    const short = rows.length < MAX_ENTRIES ? 1 : 0;
    statements.push({
      sql: `DELETE FROM history_events WHERE source = 'activity' AND at >= CASE WHEN ?2 = 1
              THEN min(?1, coalesce((SELECT CAST(value AS INTEGER) FROM index_state WHERE key = ?3), ?1))
              ELSE ?1 END`,
      params: [cutoff, short, HISTORY_STATE.mirrorFrom],
    });
    statements.push(
      ...chunks(rows, HISTORY_WRITE_ROWS).map((group) => ({
        sql: `INSERT INTO history_events (id, at, source, kind, paths, moves, n, tool, by, via, agent, team)
              ${INSERT_SELECT}
              ON CONFLICT(id) DO UPDATE SET at = excluded.at, kind = excluded.kind, paths = excluded.paths,
                moves = excluded.moves, n = excluded.n, by = excluded.by, via = excluded.via, team = excluded.team`,
        params: [JSON.stringify(group)],
      })),
    );
  }
  statements.push(setOnceStatement(HISTORY_STATE.activityFrom, cutoff ?? now));
  statements.push(...setStateStatements({
    [HISTORY_STATE.mirrorEtag]: etag ?? "",
    ...(cutoff === null ? {} : { [HISTORY_STATE.mirrorFrom]: cutoff }),
  }));
  return statements;
}

/** What the table can be trusted for. A database with no table yet reads as empty, which it is. */
export async function readHistoryState(client) {
  let rows;
  try {
    rows = await client.query("SELECT key, value FROM index_state WHERE key LIKE 'history_%'");
  } catch (error) {
    if (/no such table/i.test(String(error?.message ?? ""))) rows = [];
    else throw error;
  }
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const number = (key) => {
    if (!values.has(key)) return null;
    const value = Number(values.get(key));
    return Number.isFinite(value) ? value : null;
  };
  const floor = (key) => (values.get(key) === "none" ? "none" : number(key));
  return {
    activityFrom: number(HISTORY_STATE.activityFrom),
    mirrorFrom: number(HISTORY_STATE.mirrorFrom),
    mirrorEtag: values.has(HISTORY_STATE.mirrorEtag) ? values.get(HISTORY_STATE.mirrorEtag) : null,
    readsFrom: number(HISTORY_STATE.readsFrom),
    auditBelow: values.get(HISTORY_STATE.auditBelow) ?? null,
    readsFloor: floor(HISTORY_STATE.readsFloor),
    auditFloor: floor(HISTORY_STATE.auditFloor),
    legacyAudit: values.has(HISTORY_STATE.legacyAudit) ? values.get(HISTORY_STATE.legacyAudit) === "1" : null,
    recheckFrom: number(HISTORY_STATE.recheckFrom),
    verifiedAt: number(HISTORY_STATE.verifiedAt),
  };
}

/**
 * One page of rows in `[from, to]`, newest first, before `(beforeAt, beforeId)`.
 * Keyset rather than offset, so a page costs the same however deep it is.
 */
export async function listHistoryPage(client, { from, to, before = null, limit = HISTORY_PAGE_ROWS }) {
  const params = [from, to];
  let after = "";
  if (before !== null) {
    params.push(before.at, before.id);
    after = " AND (at < ?3 OR (at = ?3 AND id < ?4))";
  }
  params.push(Math.max(1, Math.min(limit, HISTORY_PAGE_ROWS)));
  try {
    return await client.query(
      `SELECT id, at, source, kind, paths, moves, n, tool, by, via, agent, team FROM history_events
       WHERE at >= ?1 AND at <= ?2${after} ORDER BY at DESC, id DESC LIMIT ?${params.length}`,
      params,
    );
  } catch (error) {
    if (/no such table/i.test(String(error?.message ?? ""))) return [];
    throw error;
  }
}
