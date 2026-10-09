/**
 * `GET /agent-activity?history_since=<ms>&history_until=<ms>` — a replay's
 * whole history for one context in one answer: the lines of `activity.md` (and
 * the change records older than it) and the stored reads in that stretch,
 * already filtered for the caller.
 *
 *     {history: {entries: [{at, kind, paths, by, via, moves?, agent?}],
 *                reads: [{at, path, tool, by, via}],
 *                complete, truncated, source: "index" | "bucket"}}
 *
 * New parameters on an existing route (`docs/decisions/gateway-protocol.md`),
 * for the console's client only, as `reads_since` is: any other caller is
 * answered with nothing. An older gateway ignores them, which is how the
 * console knows to ask the old way (`history` is absent).
 *
 * ## Filtered exactly as the bucket's own history is
 *
 * No rule here is new. A line goes through `visibleEntries` after its paths
 * are forwarded, with `canSee` given the console grant's live group names —
 * what `files.listActivity` applies to the same file in the control plane. A
 * read goes through `readFilterFor`, as `reads_since` does. Both re-derive
 * against the live `privacy.md` on every answer, so a row in the table decides
 * nothing about who sees it.
 *
 * ## Where the answer comes from
 *
 * From the history table (`table.js`) where the context has a database, with
 * `activity.md` read beside it on every ask: its lines are the newest truth
 * (the console writes the file without passing through the gateway), they
 * replace the table's copy of the same span, and a version the table has not
 * mirrored is mirrored behind the response. When the table does not yet reach
 * back to `history_since` a backfill pass runs first, within the search
 * budget, and an answer it could not finish says `complete: false`.
 *
 * Without a database — fast search off, a self-hosted gateway — or when it
 * fails, the same answer is built from the bucket the way a replay always was:
 * the file's lines and at most eight days of reads, and `complete` says when
 * that is short of what was asked.
 */

import {
  ACTIVITY_PATH,
  MAX_ENTRIES,
  KINDS,
  parseFile as parseActivityFile,
  visibleEntries,
} from "../../../../packages/shared/src/activity.cjs";
import { decodeMoves } from "../../../../packages/shared/src/activityMoves.cjs";
import { canSee } from "../privacy/engine.js";
import { forwardPath, readForwarding } from "../forwarding.js";
import { isConsoleActor } from "../live/presence.js";
import { READ_LOG_MAX_SPAN_MS, readsBetween, storageBudget } from "../live/readLog.js";
import { readFilterFor } from "../live/storedReads.js";
import { searchBudgetFor } from "../search/budget.js";
import { backfillHistory, coveredSince, verifyHistoryReads } from "./backfill.js";
import { keepHistoryActivity } from "./record.js";
import {
  HISTORY_PAGE_ROWS,
  ensureStatements,
  historyClientOf,
  listHistoryPage,
  mirrorFromOf,
  mirrorStatements,
  readHistoryState,
} from "./table.js";

/** At most this many rows read for one answer (lines and reads together), newest kept. */
export const HISTORY_MAX_ROWS = 4 * HISTORY_PAGE_ROWS;

/** Whether this ask is for a replay's history. */
export function asksForHistory(params) {
  return params.has("history_since");
}

function empty(source = "index") {
  return { history: { entries: [], reads: [], complete: false, truncated: false, source } };
}

/** The file's lines, or `null` when it could not be read (absent is `[]`). */
async function readFile(store) {
  try {
    const object = await store.get(ACTIVITY_PATH);
    if (!object) return { etag: null, entries: [] };
    return { etag: typeof object.etag === "string" ? object.etag : null, entries: parseActivityFile(await object.text()) };
  } catch {
    return null;
  }
}

/** A table row of a line, back in the shape the file's lines have. */
function entryOfRow(row) {
  if (!KINDS.includes(row.kind)) return null;
  let paths;
  let moves = [];
  try {
    paths = JSON.parse(row.paths);
    if (row.moves) moves = decodeMoves(JSON.parse(row.moves));
  } catch {
    return null;
  }
  if (!Array.isArray(paths)) return null;
  paths = paths.filter((path) => typeof path === "string" && path);
  if (paths.length === 0) return null;
  return {
    at: new Date(Number(row.at)).toISOString(),
    kind: row.kind,
    paths,
    n: Number(row.n) || 1,
    vis: Number(row.team) === 1 ? "team" : "private",
    by: typeof row.by === "string" ? row.by : null,
    via: typeof row.via === "string" ? row.via : null,
    note: null,
    ...(moves.length ? { moves } : {}),
    ...(Number(row.agent) === 1 && row.source === "audit" ? { agent: true } : {}),
  };
}

/** A table row of a read, in the shape `readRecordOf` gives. */
function readOfRow(row) {
  let paths;
  try {
    paths = JSON.parse(row.paths);
  } catch {
    return null;
  }
  const path = Array.isArray(paths) ? paths[0] : null;
  if (typeof path !== "string" || !path) return null;
  return {
    at: Number(row.at),
    path,
    tool: typeof row.tool === "string" ? row.tool : "read_note",
    by: typeof row.by === "string" ? row.by : null,
    via: typeof row.via === "string" ? row.via : null,
    teamVisible: Number(row.team) === 1,
  };
}

/** The two filters, built once per answer from one read of the forwarding ledger. */
async function filtersFor(session, store, privacy, forwarding) {
  const readVisible = await readFilterFor(store, session.scope, privacy.rules, privacy.overrides, { forwarding });
  const lines = (entries) =>
    visibleEntries(
      entries.map((entry) => ({ ...entry, paths: entry.paths.map((path) => forwardPath(forwarding, path)) })),
      {
        owner: session.scope === "private",
        canSee: (path) => canSee(path, session.scope, privacy.rules, privacy.overrides, session.grantedGroups),
      },
    );
  const reads = (records) => {
    const out = [];
    for (const record of records) {
      const path = readVisible(record);
      if (typeof path === "string" && path) out.push({ ...record, path });
    }
    return out;
  };
  return { lines, reads, readVisible };
}

function shapeEntry(entry) {
  return {
    at: entry.at,
    kind: entry.kind,
    paths: entry.paths,
    by: entry.by,
    via: entry.via,
    ...(entry.moves ? { moves: entry.moves } : {}),
    ...(entry.agent ? { agent: true } : {}),
  };
}

function shapeRead(read) {
  return { at: read.at, path: read.path, tool: read.tool, by: read.by, via: read.via };
}

function within(entry, from, to) {
  const at = Date.parse(entry.at);
  return Number.isFinite(at) && at >= from && at <= to;
}

/** The answer from the table, or throws for the caller to answer from the bucket. */
async function fromIndex(store, client, { from, to, now, budget, file, defer }) {
  let state = await readHistoryState(client);
  budget.take();
  // The first mirror says where audit records stop being needed, so it is
  // waited for; any later one is behind the response.
  if (file !== null && (state.activityFrom === null || state.mirrorEtag !== (file.etag ?? ""))) {
    if (state.activityFrom === null) {
      budget.take();
      await client.runAll([...ensureStatements(), ...mirrorStatements(file.entries, { etag: file.etag, now })]);
      state = await readHistoryState(client);
      budget.take();
    } else {
      defer(keepHistoryActivity(store, file.entries, file.etag));
    }
  }
  if (state.activityFrom === null) throw new Error("history has no starting point");
  if (!coveredSince(state, from, now)) state = await backfillHistory(store, client, { since: from, now, budget, state });
  const covered = coveredSince(state, from, now);
  const settled = state;

  const rows = [];
  let before = null;
  let full = false;
  for (;;) {
    const want = Math.min(HISTORY_PAGE_ROWS, HISTORY_MAX_ROWS - rows.length);
    // Exactly at the cap is counted as short: the next row may exist.
    if (want <= 0 || !budget.take()) {
      full = true;
      break;
    }
    const page = await listHistoryPage(client, { from, to, before, limit: want });
    rows.push(...page);
    if (page.length < want) break;
    const last = page.at(-1);
    before = { at: Number(last.at), id: last.id };
  }
  // A short read keeps the newest stretch whole: nothing older than its oldest row.
  const oldest = full && rows.length ? Number(rows.at(-1).at) : from;

  const fileLines = file?.entries ?? [];
  const cutoff = fileLines.reduce((low, entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && (low === null || at < low) ? at : low;
  }, null);
  // The table's copy of what the file holds now gives way to the file.
  const dropFrom = mirrorFromOf(fileLines.length, cutoff, state.mirrorFrom);
  const entries = [];
  const reads = [];
  for (const row of rows) {
    if (row.source === "read") {
      const read = readOfRow(row);
      if (read) reads.push(read);
    } else if (row.source === "audit" || dropFrom === null || Number(row.at) < dropFrom) {
      const entry = entryOfRow(row);
      if (entry) entries.push(entry);
    }
  }
  for (const entry of fileLines) if (within(entry, oldest, to)) entries.push(entry);
  // The hourly re-check, with whatever budget the answer left (`backfill.js`).
  defer(verifyHistoryReads(store, client, { now, budget, state: settled }));
  return { entries, reads, complete: covered && !full && file !== null, truncated: full };
}

/** The answer from the bucket alone: the file, and at most eight days of reads. */
async function fromBucket(store, { from, to, budget, file, readVisible }) {
  const lines = (file?.entries ?? []).filter((entry) => within(entry, from, to));
  const { reads, truncated } = await readsBetween(store, { from, to, budget, visible: readVisible });
  const cutoff = (file?.entries ?? []).reduce((low, entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && (low === null || at < low) ? at : low;
  }, null);
  const fileShort = file === null || (file.entries.length >= MAX_ENTRIES && cutoff !== null && cutoff > from);
  const spanShort = to - from > READ_LOG_MAX_SPAN_MS;
  return { entries: lines, readRecords: reads, complete: !truncated && !fileShort && !spanShort, truncated };
}

export async function historyAnswer(session, store, privacy, params, env, { now = Date.now(), defer = (work) => Promise.resolve(work).catch(() => {}) } = {}) {
  if (!isConsoleActor({ clientId: session.actorClientId })) return empty();
  if (privacy.error) return empty();
  const from = Number(params.get("history_since"));
  const toParam = params.has("history_until") ? Number(params.get("history_until")) : now;
  const to = Number.isFinite(toParam) ? Math.min(toParam, now) : now;
  if (!Number.isFinite(from) || from < 0 || from > to) return empty();

  const budget = storageBudget(searchBudgetFor(env));
  budget.take(2);
  const [file, forwarding] = await Promise.all([readFile(store), readForwarding(store)]);
  const filters = await filtersFor(session, store, privacy, forwarding);

  const client = historyClientOf(store);
  if (client !== null) {
    try {
      const found = await fromIndex(store, client, { from, to, now, budget, file, defer });
      return finish(found.entries, filters.reads(found.reads), filters, found, "index");
    } catch {
      // The database is having a bad day: the bucket still answers.
    }
  }
  // The reads filter goes into the walk, so a read nobody may see costs no answer room.
  const found = await fromBucket(store, { from, to, budget, file, readVisible: filters.readVisible });
  return finish(found.entries, found.readRecords, filters, found, "bucket");
}

function finish(entries, visibleReads, filters, found, source) {
  const lines = filters
    .lines(entries)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map(shapeEntry);
  const reads = visibleReads.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path)).map(shapeRead);
  return {
    history: { entries: lines, reads, complete: found.complete && !found.truncated, truncated: found.truncated, source },
  };
}
