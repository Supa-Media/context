/**
 * Filling the history table from the bucket, newest first, a bounded piece
 * per ask.
 *
 * Two walks, each resumable from the state it leaves in `index_state`:
 *
 *  - **Reads**, one UTC day at a time backwards from today, through the same
 *    roll-up walk a replay made (`readDayRecords`), so a day costs a listing
 *    and a roll-up rather than a fetch per read. `readsFrom` is the start of
 *    the oldest day done.
 *  - **Audit records** older than the first mirror of `activity.md`
 *    (`activityFrom`): from then on the file says everything they would, and
 *    console changes are only in the file. A calendar month is listed by key
 *    prefix (`.context/audit/2026-10`, and the legacy `.audit/` beside it when
 *    there is one), which needs no `startAfter` the R2 binding would ignore,
 *    and its records are read newest first. `auditBelow` is the smallest key
 *    done, or a month's start once the month is.
 *
 * Each walk stops at its floor — the first key its prefix lists, learnt once —
 * so a context with a year of quiet costs one listing a month to pass over,
 * and the walk only goes as far back as somebody asked.
 *
 * Every storage call and every database request is taken from one budget, the
 * one a search spends (`searchBudgetFor`): a pass ends when it runs out and
 * says so, and the next ask carries on. Rows are written before the state that
 * claims them, in one request, and a second write of a row is a no-op, so two
 * passes racing cost work and never correctness.
 */

import {
  AUDIT_PREFIX,
  READS_PREFIX,
} from "../../../../packages/shared/src/storageLayout.cjs";
import { SESSION_WINDOW_MS, entryFor } from "../../../../packages/shared/src/activity.cjs";
import { readDayRecords } from "../live/readLog.js";
import { timestampSlug } from "../notes/paths.js";
import {
  HISTORY_STATE,
  ensureStatements,
  insertStatements,
  lineRow,
  lowerStatement,
  readRow,
  setStateStatements,
} from "./table.js";

const DAY_MS = 24 * 60 * 60_000;

/** Where the audit trail lived before the storage layout's v1. */
export const LEGACY_AUDIT_PREFIX = ".audit/";

/** Records fetched at once. */
const FETCH_CONCURRENCY = 25;

/** The console's own client: a change through it is a person's hand, not a tool's. */
const CONSOLE_CLIENT_ID = "context_console";

export function dayStart(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function dayName(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthStart(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** `.context/audit/2026-10-09T12-34-56-789Z-…` → its time, or NaN. */
export function auditKeyTime(key, prefix = AUDIT_PREFIX) {
  const slug = String(key).slice(prefix.length, prefix.length + 24);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(slug);
  return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : NaN;
}

/** A boundary that sorts before every audit key at or after `ms`, and after every one before it. */
export function auditBoundary(ms) {
  return `${AUDIT_PREFIX}${timestampSlug(new Date(ms))}`;
}

/**
 * The earliest time from which every audit record is done. A boundary claims
 * its own instant; a key claims only what sorts after it, which at the same
 * millisecond may not be everything.
 */
export function auditCoveredFrom(below) {
  const at = auditKeyTime(below);
  if (!Number.isFinite(at)) return Infinity;
  return below.endsWith(".json") ? at + 1 : at;
}

/** Where each walk has got to, with the defaults a fresh table starts from. */
export function coverageOf(state, now) {
  const readsFrom = state.readsFrom ?? dayStart(now) + DAY_MS;
  const auditBelow =
    state.auditBelow ?? (state.activityFrom === null ? null : auditBoundary(state.activityFrom));
  return {
    readsFrom,
    auditBelow,
    auditFrom: auditBelow === null ? Infinity : auditCoveredFrom(auditBelow),
  };
}

/** Whether the table holds every row for `[since, now]` that the bucket does. */
export function coveredSince(state, since, now) {
  if (state.activityFrom === null || state.readsFloor === null || state.auditFloor === null) return false;
  if (state.recheckFrom !== null) return false;
  const { readsFrom, auditFrom } = coverageOf(state, now);
  const readsOk = state.readsFloor === "none" || readsFrom <= dayStart(Math.max(since, state.readsFloor));
  const auditOk =
    state.auditFloor === "none" || since >= state.activityFrom || auditFrom <= Math.max(since, state.auditFloor);
  return readsOk && auditOk;
}

async function firstKey(store, prefix) {
  const page = await store.list({ prefix, limit: 1 });
  const key = page?.objects?.[0]?.key;
  if (typeof key === "string") return key;
  // A page emptied by hidden markers says nothing about what comes after.
  return page?.truncated ? "" : null;
}

/** The floors, learnt once: the first key each prefix lists. */
async function learnFloors(store, budget) {
  if (!budget.take(3)) return null;
  const [reads, audit, legacy] = await Promise.all([
    firstKey(store, READS_PREFIX),
    firstKey(store, AUDIT_PREFIX),
    firstKey(store, LEGACY_AUDIT_PREFIX),
  ]);
  const readsDay = reads === null ? null : Date.parse(`${reads.slice(READS_PREFIX.length, READS_PREFIX.length + 10)}T00:00:00Z`);
  const readsFloor = reads === null ? "none" : Number.isFinite(readsDay) ? readsDay : 0;
  const times = [];
  if (audit !== null) times.push(audit === "" ? 0 : auditKeyTime(audit));
  if (legacy !== null) times.push(legacy === "" ? 0 : auditKeyTime(legacy, LEGACY_AUDIT_PREFIX));
  const auditFloor = times.length === 0 ? "none" : Math.min(...times.map((at) => (Number.isFinite(at) ? at : 0)));
  return { readsFloor, auditFloor, legacyAudit: legacy !== null };
}

/** One write: the rows first, then the state that claims them. */
async function write(client, budget, statements) {
  if (statements.length === 0) return true;
  if (!budget.take()) return false;
  await client.runAll([...ensureStatements(), ...statements]);
  return true;
}

/** A day's reads as rows; `complete` when the day is whole. */
async function readsStep(store, day, budget) {
  const { records, complete } = await readDayRecords(store, dayName(day), budget);
  const rows = records.map(({ key, ...record }) => readRow(key, record));
  return { rows, complete };
}

/** A month's audit keys below `below`, newest first, each with where it really lives. */
async function monthKeys(store, month, below, legacy, budget) {
  const name = new Date(month).toISOString().slice(0, 7);
  const keys = new Map();
  const prefixes = [[AUDIT_PREFIX, AUDIT_PREFIX]];
  if (legacy) prefixes.push([LEGACY_AUDIT_PREFIX, AUDIT_PREFIX]);
  for (const [from, as] of prefixes) {
    let cursor;
    do {
      if (!budget.take()) return null;
      const page = await store.list({ prefix: `${from}${name}`, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const object of page?.objects ?? []) {
        if (typeof object?.key !== "string" || !object.key.endsWith(".json")) continue;
        const named = `${as}${object.key.slice(from.length)}`;
        // The v1 copy wins over a pre-v1 one of the same record.
        if (named < below && (!keys.has(named) || from === AUDIT_PREFIX)) keys.set(named, object.key);
      }
      cursor = page?.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return [...keys.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
}

/**
 * An audit record as a row, built the way the file builds its lines, or null
 * for one the file would not have shown. The record names no hand by name —
 * only ids — so `by`/`via` stay empty and `agent` says whether it was a tool.
 */
export function auditRow(name, record) {
  if (!record || typeof record !== "object") return null;
  const at = typeof record.at === "string" && Number.isFinite(Date.parse(record.at))
    ? record.at
    : new Date(auditKeyTime(name)).toISOString();
  const entry = entryFor({
    action: record.action,
    paths: record.paths,
    details: record.details && typeof record.details === "object" ? record.details : {},
    actor: null,
    at,
  });
  if (entry === null) return null;
  const client = record.actor_client_id;
  return lineRow(entry, { id: name, source: "audit", agent: typeof client === "string" && client !== CONSOLE_CLIENT_ID });
}

/**
 * Whether a line of the file already says what this record does: the same
 * kind (or an `added` line that absorbed a revision), naming its first path,
 * written within the window the file merges over. Only records just before
 * `activityFrom` can be inside a line's window.
 */
function saidByFile(row, lines) {
  const kind = row[3];
  const first = JSON.parse(row[4])[0];
  return lines.some(
    (line) =>
      (line.kind === kind || (line.kind === "added" && kind === "revised")) &&
      line.paths.includes(first) &&
      line.at >= row[1] &&
      line.at - row[1] <= SESSION_WINDOW_MS,
  );
}

async function auditStep(store, client, state, below, budget, boundaryLines) {
  const covered = auditCoveredFrom(below);
  const month = monthStart(covered - 1);
  const keys = await monthKeys(store, month, below, state.legacyAudit === true, budget);
  if (keys === null) return { rows: [], below: null };
  // One request kept back for writing what was read.
  const affordable = Math.max(0, Math.min(keys.length, budget.left - 1));
  const rows = [];
  let done = null;
  for (let start = 0; start < affordable; start += FETCH_CONCURRENCY) {
    const batch = keys.slice(start, Math.min(affordable, start + FETCH_CONCURRENCY));
    budget.take(batch.length);
    const bodies = await Promise.all(
      batch.map(async ([, actual]) => {
        try {
          const object = await store.get(actual);
          if (!object) return { gone: true };
          try {
            return { record: JSON.parse(await object.text()) };
          } catch {
            return { record: null };
          }
        } catch {
          return { failed: true };
        }
      }),
    );
    let stopped = false;
    for (let index = 0; index < batch.length; index += 1) {
      // A record that could not be read now is not passed over for good.
      if (bodies[index].failed) {
        stopped = true;
        break;
      }
      const row = auditRow(batch[index][0], bodies[index].record);
      if (row !== null && row[1] < state.activityFrom) {
        if (row[1] >= state.activityFrom - SESSION_WINDOW_MS) {
          const lines = await boundaryLines();
          if (lines === null) {
            stopped = true;
            break;
          }
          if (!saidByFile(row, lines)) rows.push(row);
        } else {
          rows.push(row);
        }
      }
      done = batch[index][0];
    }
    if (stopped) break;
  }
  const whole = done !== null ? done === keys.at(-1)?.[0] : keys.length === 0;
  return { rows, below: whole ? auditBoundary(month) : done };
}

/**
 * One pass towards `since`. Returns the state as this pass left it.
 *
 * @param {{ list: Function, get: Function, put: Function }} store
 * @param {{ query: Function, runAll: Function }} client
 * @param {{ since: number, now: number, budget: { take: Function, left: number }, state: object }} options
 */
export async function backfillHistory(store, client, { since, now, budget, state: initial }) {
  let state = { ...initial };
  if (state.activityFrom === null) return state;

  if (state.readsFloor === null || state.auditFloor === null || state.legacyAudit === null) {
    const floors = await learnFloors(store, budget);
    if (floors === null) return state;
    const saved = await write(client, budget, setStateStatements({
      [HISTORY_STATE.readsFloor]: floors.readsFloor,
      [HISTORY_STATE.auditFloor]: floors.auditFloor,
      [HISTORY_STATE.legacyAudit]: floors.legacyAudit ? 1 : 0,
    }));
    if (!saved) return state;
    state = { ...state, ...floors };
  }

  // Days whose rows the write path failed to land are read again first.
  while (state.recheckFrom !== null && budget.left >= 5) {
    const day = state.recheckFrom;
    const { rows, complete } = await readsStep(store, day, budget);
    const next = day + DAY_MS > dayStart(now) ? null : day + DAY_MS;
    const statements = insertStatements(rows);
    if (complete) {
      statements.push({
        sql: next === null
          ? "DELETE FROM index_state WHERE key = ?1 AND value = ?2"
          : "UPDATE index_state SET value = ?3 WHERE key = ?1 AND value = ?2",
        params: next === null
          ? [HISTORY_STATE.recheckFrom, String(day)]
          : [HISTORY_STATE.recheckFrom, String(day), String(next)],
      });
    }
    if (!(await write(client, budget, statements)) || !complete) return state;
    state = { ...state, recheckFrom: next };
  }

  let lines;
  const boundaryLines = async () => {
    if (lines !== undefined) return lines;
    if (!budget.take()) return (lines = null);
    const found = await client.query(
      "SELECT at, kind, paths FROM history_events WHERE source = 'activity' AND at >= ?1 AND at <= ?2",
      [state.activityFrom, state.activityFrom + SESSION_WINDOW_MS],
    );
    lines = found.map((row) => ({ at: Number(row.at), kind: row.kind, paths: JSON.parse(row.paths) }));
    return lines;
  };

  for (;;) {
    const { readsFrom, auditBelow, auditFrom } = coverageOf(state, now);
    const readsLow = state.readsFloor === "none" ? Infinity : dayStart(Math.max(since, state.readsFloor));
    const auditLow = state.auditFloor === "none" ? Infinity : Math.max(since, state.auditFloor);
    const wantReads = readsFrom > readsLow;
    const wantAudit = auditBelow !== null && auditFrom > auditLow;
    if (!wantReads && !wantAudit) return state;
    if (budget.left < 4) return state;

    // Newest first: whichever walk is further from the past goes next.
    if (wantReads && (!wantAudit || readsFrom >= auditFrom)) {
      const day = readsFrom - DAY_MS;
      const { rows, complete } = await readsStep(store, day, budget);
      const statements = insertStatements(rows);
      if (complete) statements.push(lowerStatement(HISTORY_STATE.readsFrom, day));
      if (!(await write(client, budget, statements)) || !complete) return state;
      state = { ...state, readsFrom: Math.min(state.readsFrom ?? Infinity, day) };
    } else {
      const step = await auditStep(store, client, state, auditBelow, budget, boundaryLines);
      if (step.below === null) {
        await write(client, budget, insertStatements(step.rows));
        return state;
      }
      const statements = [
        ...insertStatements(step.rows),
        lowerStatement(HISTORY_STATE.auditBelow, step.below, { numeric: false }),
      ];
      if (!(await write(client, budget, statements))) return state;
      state = { ...state, auditBelow: state.auditBelow === null || step.below < state.auditBelow ? step.below : state.auditBelow };
      if (step.below === auditBelow) return state;
    }
  }
}

/** How often the recent days' reads are compared with the bucket again. */
export const VERIFY_MS = 60 * 60_000;

/** How far back one verification reaches: a week, plus today. */
const VERIFY_DAYS = 8;

/**
 * The hourly re-check, behind a replay's response: every day since the last
 * one, read again through the roll-up walk and written idempotently.
 *
 * It is how a read whose row was lost with the database itself unreachable —
 * so not even `recheckFrom` could be set — comes back: the bucket is the
 * record, and this is the table asking it again, the way the tree table's
 * hourly sweep does. A day already whole costs a listing and a roll-up.
 */
export async function verifyHistoryReads(store, client, { now, budget, state }) {
  if (state.readsFloor === "none" || state.readsFrom === null) return false;
  const last = state.verifiedAt ?? 0;
  if (now - last < VERIFY_MS) return false;
  const today = dayStart(now);
  const first = Math.max(dayStart(last), today - (VERIFY_DAYS - 1) * DAY_MS, state.readsFrom);
  for (let day = today; day >= first; day -= DAY_MS) {
    if (budget.left < 4) return false;
    const { rows, complete } = await readsStep(store, day, budget);
    if (!(await write(client, budget, insertStatements(rows))) || !complete) return false;
  }
  return await write(client, budget, setStateStatements({ [HISTORY_STATE.verifiedAt]: now }));
}
