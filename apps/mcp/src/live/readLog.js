/**
 * What AI clients read, kept in the customer's own bucket.
 *
 * Reads used to live only in the activity object's memory window, so a
 * replay could show what was written, made and moved but never what an AI
 * read, and nobody could ask afterwards which notes a tool had opened. Both
 * are now answered from `.context/reads/` (decided by the owner, 2026-10-07;
 * `docs/decisions/gateway-protocol/stored-reads.md`):
 *
 *  - **One object per read**, `.context/reads/<YYYY-MM-DD>/<time>-<id>.json`,
 *    written once and never rewritten. A per-read object needs no conditional
 *    write, which B2 and Wasabi do not reliably have, and two tools reading in
 *    the same millisecond never race. These are the record.
 *  - **A roll-up per UTC day**, `.context/reads/<YYYY-MM-DD>.json`, holding
 *    the records already gathered. A derivative: rebuilt from the per-read
 *    objects whenever it is missing or behind, never the only copy of a read,
 *    so a lost or stale roll-up costs reads and never loses one. It exists
 *    because a replay must not spend one subrequest per read, against a
 *    Worker budget of 50 on the free plan.
 *
 * A record names the path, the tool, who (`by`, `via`, as `activity.md` names
 * them, so a replay draws one face for one hand) and whether the note was
 * `team` when it was read. That flag is the event-time half of the filter a
 * non-owner gets: a note read while private never shows its read to the team,
 * even after it is shared.
 */

import { READS_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";
import { effectiveVisibility, isPlumbing } from "../privacy/engine.js";
import { loadPrivacyState } from "../privacy/state.js";
import { timestampSlug } from "../notes/paths.js";
import { isConsoleActor } from "./presence.js";

const DAY_MS = 24 * 60 * 60_000;

/** The longest stretch one ask may cover: a week, plus the day it started on. */
export const READ_LOG_MAX_SPAN_MS = 8 * DAY_MS;

/** At most this many reads in one answer, newest kept. */
export const READ_LOG_MAX_ANSWER = 3000;

/** Per-read objects fetched at once when a roll-up is behind. */
const FETCH_CONCURRENCY = 25;

const ROLLUP_VERSION = 1;

function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayFolder(day) {
  return `${READS_PREFIX}${day}/`;
}

function rollupKey(day) {
  return `${READS_PREFIX}${day}.json`;
}

/**
 * Store one read, behind the response. Never for the console's own client
 * (a person opening a note is not an AI reading it), and never a plumbing
 * path. A failure costs this one record; the tool call already succeeded.
 */
export function recordAgentRead(store, { tool, path }) {
  const actor = store?.actor;
  if (!actor || isConsoleActor(actor)) return;
  if (typeof path !== "string" || !path || isPlumbing(path)) return;
  if (typeof store.put !== "function") return;
  const work = (async () => {
    try {
      const at = new Date();
      const state = await loadPrivacyState(store);
      const record = {
        at: at.toISOString(),
        tool: typeof tool === "string" ? tool : "read_note",
        path,
        by: typeof actor.name === "string" ? actor.name : null,
        via: typeof actor.client === "string" ? actor.client : null,
        actor_user_id: actor.userId ?? null,
        actor_client_id: actor.clientId ?? null,
        workspace_id: actor.workspaceId ?? null,
        // Group-scoped and unparseable both read as "not team": fail closed.
        team_visible: !state.error && effectiveVisibility(path, state.rules, state.overrides) === "team",
      };
      const key = `${dayFolder(dayOf(at.getTime()))}${timestampSlug(at)}-${crypto.randomUUID()}.json`;
      await store.put(key, JSON.stringify(record));
    } catch {
      // One read unrecorded. Nothing the caller did depends on it.
    }
  })();
  if (typeof store.defer === "function") {
    try {
      store.defer(work);
    } catch {
      // A host that refuses deferred work still gets the write it started.
    }
  }
}

/** A stored record, re-checked field by field; `null` for anything else. */
export function readRecordOf(value) {
  if (!value || typeof value !== "object") return null;
  const at = Date.parse(value.at);
  if (!Number.isFinite(at)) return null;
  if (typeof value.path !== "string" || !value.path || isPlumbing(value.path)) return null;
  return {
    at,
    path: value.path,
    tool: typeof value.tool === "string" ? value.tool : "read_note",
    by: typeof value.by === "string" ? value.by : null,
    via: typeof value.via === "string" ? value.via : null,
    teamVisible: value.team_visible === true,
  };
}

/** A budget of storage calls, spent one at a time. */
export function storageBudget(total) {
  let left = Math.max(0, Math.floor(total));
  return {
    take(count = 1) {
      if (left < count) return false;
      left -= count;
      return true;
    },
    get left() {
      return left;
    },
  };
}

async function listDay(store, day, budget) {
  const keys = [];
  let cursor;
  do {
    if (!budget.take()) return { keys, complete: false };
    const page = await store.list({ prefix: dayFolder(day), cursor, limit: 1000 });
    for (const object of page?.objects ?? []) {
      if (typeof object?.key === "string" && object.key.endsWith(".json")) keys.push(object.key);
    }
    cursor = page?.truncated ? page.cursor : undefined;
  } while (cursor);
  return { keys, complete: true };
}

async function readJson(store, key) {
  const object = await store.get(key);
  if (!object) return null;
  try {
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}

async function rollupOf(store, day) {
  const body = await readJson(store, rollupKey(day));
  const records = new Map();
  if (body?.version === ROLLUP_VERSION && Array.isArray(body.records)) {
    for (const entry of body.records) {
      if (entry && typeof entry.key === "string" && entry.key.startsWith(dayFolder(day))) {
        records.set(entry.key, entry);
      }
    }
  }
  return records;
}

/**
 * One day's records: the roll-up, plus whatever per-read objects it does not
 * hold yet, fetched newest first while the budget lasts. When any were
 * fetched, the roll-up is written back with them, so the next ask is cheaper.
 */
async function readDay(store, day, budget) {
  const listed = await listDay(store, day, budget);
  if (!budget.take()) return { records: [], complete: false };
  const rolled = await rollupOf(store, day);
  let pruned = false;
  // The listing is the record; the roll-up only saves reading it. An entry
  // whose object is gone (or was never there) is not a read.
  if (listed.complete) {
    const present = new Set(listed.keys);
    for (const key of [...rolled.keys()]) {
      if (!present.has(key)) {
        rolled.delete(key);
        pruned = true;
      }
    }
  }
  const missing = listed.keys.filter((key) => !rolled.has(key)).sort().reverse();
  // One call kept back for writing the roll-up.
  const affordable = Math.max(0, Math.min(missing.length, budget.left - 1));
  const fetched = [];
  for (let start = 0; start < affordable; start += FETCH_CONCURRENCY) {
    const batch = missing.slice(start, Math.min(affordable, start + FETCH_CONCURRENCY));
    budget.take(batch.length);
    const bodies = await Promise.all(batch.map((key) => readJson(store, key).catch(() => null)));
    batch.forEach((key, index) => {
      if (bodies[index] && typeof bodies[index] === "object") fetched.push({ ...bodies[index], key });
    });
  }
  for (const entry of fetched) rolled.set(entry.key, entry);
  if ((fetched.length > 0 || pruned) && budget.take()) {
    try {
      const records = [...rolled.values()].sort((a, b) => a.key.localeCompare(b.key));
      await store.put(rollupKey(day), JSON.stringify({ version: ROLLUP_VERSION, records }));
    } catch {
      // The roll-up is a convenience; the records are already in hand.
    }
  }
  const records = [];
  for (const entry of rolled.values()) {
    const record = readRecordOf(entry);
    if (record) records.push(record);
  }
  return { records, complete: listed.complete && affordable === missing.length };
}

/**
 * The reads stored in `[from, to]` that `visible` admits, oldest first.
 *
 * `visible(record)` decides per caller (event-time flag, then the live
 * manifest) and answers the path to show, which may be where the note is
 * now, or `null` to leave the read out. `truncated` says the answer is short —
 * the budget ran out or the window held more than `READ_LOG_MAX_ANSWER` —
 * and a short list is never presented as a complete one.
 */
export async function readsBetween(store, { from, to, budget, visible }) {
  const end = Math.floor(to);
  const start = Math.max(Math.floor(from), end - READ_LOG_MAX_SPAN_MS);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return { reads: [], truncated: false };
  const days = [];
  for (let day = Date.parse(`${dayOf(end)}T00:00:00Z`); day + DAY_MS > start; day -= DAY_MS) days.push(dayOf(day));
  const reads = [];
  let truncated = false;
  // Newest day first, so a budget that runs out costs the oldest reads.
  for (const day of days) {
    if (budget.left < 2) {
      truncated = true;
      break;
    }
    const { records, complete } = await readDay(store, day, budget);
    if (!complete) truncated = true;
    for (const record of records) {
      if (record.at < start || record.at > end) continue;
      const path = visible(record);
      if (typeof path === "string" && path) reads.push({ ...record, path });
    }
  }
  reads.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
  if (reads.length > READ_LOG_MAX_ANSWER) {
    truncated = true;
    reads.splice(0, reads.length - READ_LOG_MAX_ANSWER);
  }
  return { reads, truncated };
}
