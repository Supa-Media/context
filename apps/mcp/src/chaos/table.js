/**
 * The chaos score, kept in the context's own tree database as notes change.
 *
 * ## What a row is
 *
 * One row per folder (`""` is the root): its items, its weight and its sum of
 * chaos (`rubric.js`), twice — once over every note, once over only the
 * notes the workspace's team can open. A folder's chaos is `sum / weight`;
 * the workspace's is `Σsum / Σweight`, one query at any size.
 *
 * ## Why two audiences
 *
 * The score counts notes. A member counting notes held back from them could
 * learn those notes exist, which `privacy.md` exists to prevent, so a reader
 * who cannot see everything gets the team numbers: computed over what the
 * team can open, with folder names only where a team note sits beneath them.
 * A connection with group grants reads the team numbers too, which is the
 * conservative side of the same line.
 *
 * ## Kept current, cheaply
 *
 * A change rescores the folders it touched, bottom up: a folder moved in is
 * scored whole from its own rows, then each parent from its direct notes and
 * its subfolders' rows, walking up only while a folder appeared or vanished,
 * because only that changes the parent's item count. A note written through
 * a tool is re-read for its length on the way, so the long-note rule is never
 * a save behind for the agent that just wrote it.
 *
 * Like the rest of this database it is a disposable derivative: delete it
 * and the next full pass rebuilds it from the tree.
 */

import { isMeetingNotePath } from "../../../../packages/meetings/src/paths.js";
import { TREE_STATEMENTS, TREE_PAGE_ROWS, prefixEnd, setStateStatements } from "../tree/table.js";
import { PROP_STATEMENTS, propWriteStatement } from "../tree/props.js";
import { isArchived, parentOf, scoreFolder, treeShape } from "./rubric.js";

export const CHAOS_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS tree_chaos (
     folder      TEXT PRIMARY KEY,
     items       INTEGER NOT NULL,
     weight      INTEGER NOT NULL,
     sum         REAL NOT NULL,
     team_exists INTEGER NOT NULL,
     team_items  INTEGER NOT NULL,
     team_weight INTEGER NOT NULL,
     team_sum    REAL NOT NULL
   ) WITHOUT ROWID`,
]);

/** `index_state` keys. */
export const CHAOS_STATE = Object.freeze({
  /** A full pass has scored every folder at least once. */
  ready: "chaos_ready",
  /** The last 35 days' closing scores, `{ "YYYY-MM-DD": [all, team] }`. */
  daily: "chaos_daily",
});

/** Days of closing scores kept, enough for "this week" and "this month". */
const DAILY_DAYS = 35;

/** Notes one change re-reads for their length. */
const REFRESH_NOTES = 20;

/** Folders one change may rescore one by one before it asks for a full pass instead. */
export const RESCORE_FOLDERS = 40;

const ensure = () => [...TREE_STATEMENTS, ...PROP_STATEMENTS, ...CHAOS_STATEMENTS].map((sql) => ({ sql, params: [] }));

/** Whether a note is exempt from the long-note rule: meetings and generated notes. */
function isExempt(path, type, generated) {
  if (type === "meeting" || isMeetingNotePath(path)) return true;
  return generated === 1 || generated === true || generated === "true";
}

const ROW_COLUMNS = `t.path AS path,
  json_extract(p.props, '$.lines') AS lines,
  json_extract(p.props, '$.properties.type') AS type,
  json_extract(p.props, '$.properties.generated') AS generated`;

function rowFrom(row) {
  return {
    path: row.path,
    lines: Number.isFinite(row.lines) ? row.lines : null,
    exempt: isExempt(row.path, row.type, row.generated),
  };
}

/** Every key under `folder` (`""` for all), with what the rubric needs of it. */
async function subtreeRows(client, folder) {
  const prefix = folder === "" ? "" : `${folder}/`;
  const end = prefixEnd(prefix);
  const rows = [];
  let after = "";
  for (;;) {
    const bounds = ["t.path > ?1"];
    const params = [after];
    if (prefix !== "") {
      params.push(prefix, end);
      bounds.push("t.path >= ?2", "t.path < ?3");
    }
    params.push(TREE_PAGE_ROWS);
    const page = await client.query(
      `SELECT ${ROW_COLUMNS} FROM tree AS t LEFT JOIN tree_props AS p ON p.path = t.path
       WHERE ${bounds.join(" AND ")} ORDER BY t.path LIMIT ?${params.length}`,
      params,
    );
    rows.push(...page.map(rowFrom));
    if (page.length < TREE_PAGE_ROWS) return rows;
    after = page[page.length - 1].path;
  }
}

/** The keys directly in `folder`. */
async function directRows(client, folder) {
  if (folder === "") {
    const rows = await client.query(
      `SELECT ${ROW_COLUMNS} FROM tree AS t LEFT JOIN tree_props AS p ON p.path = t.path
       WHERE instr(t.path, '/') = 0`,
    );
    return rows.map(rowFrom);
  }
  const prefix = `${folder}/`;
  const rows = await client.query(
    `SELECT ${ROW_COLUMNS} FROM tree AS t LEFT JOIN tree_props AS p ON p.path = t.path
     WHERE t.path >= ?1 AND t.path < ?2 AND instr(substr(t.path, ?3), '/') = 0`,
    [prefix, prefixEnd(prefix), prefix.length + 1],
  );
  return rows.map(rowFrom);
}

/** The scored subfolders directly in `folder`, as rows of this table. */
async function childFolders(client, folder) {
  if (folder === "") {
    return await client.query("SELECT folder, team_exists FROM tree_chaos WHERE folder <> '' AND instr(folder, '/') = 0");
  }
  const prefix = `${folder}/`;
  return await client.query(
    `SELECT folder, team_exists FROM tree_chaos
     WHERE folder >= ?1 AND folder < ?2 AND instr(substr(folder, ?3), '/') = 0`,
    [prefix, prefixEnd(prefix), prefix.length + 1],
  );
}

const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);

function upsert(folder, all, team, teamExists) {
  return {
    sql: `INSERT INTO tree_chaos (folder, items, weight, sum, team_exists, team_items, team_weight, team_sum)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
          ON CONFLICT(folder) DO UPDATE SET items = excluded.items, weight = excluded.weight, sum = excluded.sum,
            team_exists = excluded.team_exists, team_items = excluded.team_items,
            team_weight = excluded.team_weight, team_sum = excluded.team_sum`,
    params: [folder, all.items, all.weight, all.sum, teamExists ? 1 : 0, team.items, team.weight, team.sum],
  };
}

function removeSubtree(folder) {
  if (folder === "") return [{ sql: "DELETE FROM tree_chaos", params: [] }];
  const prefix = `${folder}/`;
  return [
    { sql: "DELETE FROM tree_chaos WHERE folder = ?1", params: [folder] },
    { sql: "DELETE FROM tree_chaos WHERE folder >= ?1 AND folder < ?2", params: [prefix, prefixEnd(prefix)] },
  ];
}

/**
 * Score `folder` and everything under it from its own rows, replacing what
 * the table held for them.
 */
async function rescoreSubtree(client, folder, visibleToTeam) {
  const rows = await subtreeRows(client, folder);
  const inside = (path) => folder === "" || path === folder || path.startsWith(`${folder}/`);
  const all = treeShape(rows);
  const team = treeShape(rows.filter((row) => visibleToTeam(row.path)));
  const statements = removeSubtree(folder);
  for (const [path, entry] of all) {
    if (!inside(path) || isArchived(path)) continue;
    const teamEntry = team.get(path);
    const scoredAll = scoreFolder({ path, notes: entry.notes, folders: [...entry.folders] });
    const scoredTeam = teamEntry
      ? scoreFolder({ path, notes: teamEntry.notes, folders: [...teamEntry.folders] })
      : { items: 0, weight: 0, sum: 0 };
    statements.push(upsert(path, scoredAll, scoredTeam, teamEntry !== undefined));
  }
  await client.runAll(statements);
}

/**
 * Score one folder from its direct notes and its subfolders' rows.
 *
 * @returns {Promise<{ existed: boolean, exists: boolean, teamChanged?: boolean, before: object | null, after: object | null }>}
 */
async function rescoreOne(client, folder, visibleToTeam) {
  const [previous] = await client.query("SELECT * FROM tree_chaos WHERE folder = ?1", [folder]);
  const notes = (await directRows(client, folder)).filter((row) => row.path.toLowerCase().endsWith(".md"));
  const subfolders = await childFolders(client, folder);
  const exists = folder === "" || notes.length > 0 || subfolders.length > 0;
  if (!exists) {
    if (previous) await client.runAll(removeSubtree(folder));
    return { existed: previous !== undefined, exists: false, before: previous ?? null, after: null };
  }
  const asNote = (row) => ({ name: nameOf(row.path), lines: row.lines, exempt: row.exempt });
  const all = scoreFolder({ path: folder, notes: notes.map(asNote), folders: subfolders.map((row) => nameOf(row.folder)) });
  const teamNotes = notes.filter((row) => visibleToTeam(row.path));
  const teamFolders = subfolders.filter((row) => Number(row.team_exists) === 1);
  const teamExists = folder === "" || teamNotes.length > 0 || teamFolders.length > 0;
  const team = teamExists
    ? scoreFolder({ path: folder, notes: teamNotes.map(asNote), folders: teamFolders.map((row) => nameOf(row.folder)) })
    : { items: 0, weight: 0, sum: 0 };
  await client.runAll([upsert(folder, all, team, teamExists)]);
  const existed = previous !== undefined;
  const teamExisted = existed && Number(previous.team_exists) === 1;
  return {
    existed,
    exists: true,
    teamChanged: teamExisted !== teamExists,
    before: previous ?? null,
    after: { folder, items: all.items, weight: all.weight, sum: all.sum, team_items: team.items, team_weight: team.weight, team_sum: team.sum, team_exists: teamExists ? 1 : 0 },
  };
}

/** The workspace's numbers, for both audiences. */
export async function chaosTotals(client) {
  const [row] = await client.query(
    "SELECT coalesce(sum(sum), 0) AS s, coalesce(sum(weight), 0) AS w, coalesce(sum(team_sum), 0) AS ts, coalesce(sum(team_weight), 0) AS tw FROM tree_chaos",
  );
  const score = (sum, weight) => (Number(weight) > 0 ? Number(sum) / Number(weight) : 0);
  return { all: score(row?.s, row?.w), team: score(row?.ts, row?.tw) };
}

/** Whether the table has been filled once. */
export async function chaosReady(client) {
  try {
    const [row] = await client.query("SELECT value FROM index_state WHERE key = ?1", [CHAOS_STATE.ready]);
    return row?.value === "1";
  } catch {
    return false;
  }
}

function dayOf(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Record today's closing score, keeping the last `DAILY_DAYS` days. */
async function recordDaily(client, totals, now) {
  let daily = {};
  try {
    const [row] = await client.query("SELECT value FROM index_state WHERE key = ?1", [CHAOS_STATE.daily]);
    daily = row?.value ? JSON.parse(row.value) : {};
  } catch {
    daily = {};
  }
  daily[dayOf(now)] = [Math.round(totals.all * 10) / 10, Math.round(totals.team * 10) / 10];
  const kept = Object.keys(daily).sort().slice(-DAILY_DAYS);
  const trimmed = Object.fromEntries(kept.map((day) => [day, daily[day]]));
  await client.runAll(setStateStatements({ [CHAOS_STATE.daily]: JSON.stringify(trimmed) }));
}

/** The score some days ago (the closest recorded day at or before then), or null. */
export async function chaosOn(client, daysAgo, audience, now = Date.now()) {
  try {
    const [row] = await client.query("SELECT value FROM index_state WHERE key = ?1", [CHAOS_STATE.daily]);
    const daily = row?.value ? JSON.parse(row.value) : {};
    const target = dayOf(now - daysAgo * 86_400_000);
    const day = Object.keys(daily).sort().filter((value) => value <= target).pop();
    if (!day) return null;
    return daily[day][audience === "team" ? 1 : 0];
  } catch {
    return null;
  }
}

/**
 * Score every folder from scratch. Run once the tree and its properties are
 * whole, and whenever a change is too wide to follow folder by folder.
 */
export async function chaosFullPass(client, { visibleToTeam, now = Date.now() }) {
  await client.runAll(ensure());
  await rescoreSubtree(client, "", visibleToTeam);
  // The root row comes from the subtree pass; rescoring it alone adds nothing.
  await client.runAll(setStateStatements({ [CHAOS_STATE.ready]: 1 }));
  const totals = await chaosTotals(client);
  await recordDaily(client, totals, now);
  return totals;
}

/**
 * Re-read the notes a tool just wrote, so their length is current before
 * they are scored. Best effort: a note that cannot be read keeps the length
 * it had.
 */
async function refreshLengths(store, client, files) {
  if (!store || typeof store.get !== "function") return;
  const statements = [];
  for (const path of files) {
    if (!path.toLowerCase().endsWith(".md")) continue;
    try {
      const [row] = await client.query("SELECT etag FROM tree WHERE path = ?1", [path]);
      if (!row) continue;
      const object = await store.get(path);
      if (!object) continue;
      statements.push(propWriteStatement(path, row.etag ?? null, await object.text()));
    } catch {
      // The fill pass reads it later.
    }
  }
  if (statements.length > 0) await client.runAll(statements);
}

/**
 * Carry the parsed lengths of moved notes to their new paths, so a long note
 * moved is still long before the fill pass reads it again. The copy carries
 * no version, which marks it for that re-read.
 */
async function carryLengths(client, moves) {
  const statements = [];
  for (const [from, to] of moves) {
    if (typeof from !== "string" || typeof to !== "string" || from === "" || to === "") continue;
    const prefix = `${from}/`;
    statements.push({
      sql: `INSERT INTO tree_props (path, version, encrypted, props)
            SELECT ?1 || substr(path, ?2), NULL, encrypted, props FROM tree_props
            WHERE path = ?3 OR (path >= ?4 AND path < ?5)
            ON CONFLICT(path) DO NOTHING`,
      params: [to, from.length + 1, from, prefix, prefixEnd(prefix)],
    });
  }
  if (statements.length > 0) await client.runAll(statements);
}

/**
 * Rescore what a change touched and say what it did to the score.
 *
 * @param {{ query: Function, runAll: Function }} client
 * @param {{ paths?: string[], files?: string[], moves?: [string, string][], visibleToTeam: (path: string) => boolean, store?: object, now?: number }} change
 *   `paths` may be notes or folders (a move names both ends); `files` are notes a tool wrote;
 *   `moves` pairs a moved note or folder's old path with its new one.
 * @returns {Promise<null | { before: { all: number, team: number }, after: { all: number, team: number }, folders: object[] }>}
 *   null when the table is not filled yet, or the change was too wide to follow.
 */
export async function rescoreChange(client, { paths = [], files = [], moves = [], visibleToTeam, store, now = Date.now() }) {
  await client.runAll(ensure());
  if (!(await chaosReady(client))) return null;
  const before = await chaosTotals(client);
  const named = [...new Set([...paths, ...files].filter((path) => typeof path === "string" && path !== ""))]
    .map((path) => path.replace(/^\/+|\/+$/g, ""))
    .filter((path) => path !== "" && !path.split("/").some((part) => part.startsWith(".")));
  await carryLengths(client, moves);
  // A note created or moved is read for its length too; a folder move's notes wait for the fill pass.
  await refreshLengths(store, client, [...new Set([...files, ...paths])].slice(0, REFRESH_NOTES));

  const changed = new Map();
  const note = (folder, result) => {
    if (!changed.has(folder)) changed.set(folder, { folder, before: result.before });
    changed.get(folder).after = result.after;
  };
  const queue = [];
  for (const path of named) {
    if (isArchived(path)) continue;
    // A folder named by the change (a folder moved, or a note's old place) is scored whole.
    const [inside] = await client.query("SELECT 1 AS found FROM tree WHERE path >= ?1 AND path < ?2 LIMIT 1", [
      `${path}/`,
      prefixEnd(`${path}/`),
    ]);
    if (inside) {
      const [previous] = await client.query("SELECT * FROM tree_chaos WHERE folder = ?1", [path]);
      await rescoreSubtree(client, path, visibleToTeam);
      const [current] = await client.query("SELECT * FROM tree_chaos WHERE folder = ?1", [path]);
      note(path, { before: previous ?? null, after: current ?? null });
    } else {
      const [previous] = await client.query("SELECT * FROM tree_chaos WHERE folder = ?1", [path]);
      if (previous) {
        await client.runAll(removeSubtree(path));
        note(path, { before: previous, after: null });
      }
    }
    queue.push(parentOf(path));
  }
  const seen = new Set();
  let rescored = 0;
  while (queue.length > 0) {
    const folder = queue.shift();
    if (seen.has(folder) || isArchived(folder)) continue;
    seen.add(folder);
    if (rescored >= RESCORE_FOLDERS) {
      // Too wide to follow: score it all.
      await rescoreSubtree(client, "", visibleToTeam);
      break;
    }
    rescored += 1;
    const result = await rescoreOne(client, folder, visibleToTeam);
    note(folder, result);
    // A folder that appeared or vanished changes its parent's item count.
    if (folder !== "" && (result.existed !== result.exists || result.teamChanged)) queue.push(parentOf(folder));
  }
  const after = await chaosTotals(client);
  await recordDaily(client, after, now);
  return { before, after, folders: [...changed.values()] };
}

/**
 * What a reader sees: the score, and the places that would calm it most.
 *
 * @param {{ query: Function }} client
 * @param {{ audience: "all" | "team", limit?: number, visible?: (path: string) => boolean, now?: number }} options
 *   `visible` decides which long notes may be named to this reader.
 */
export async function chaosSummary(client, { audience, limit = 5, visible = () => true, now = Date.now() }) {
  if (!(await chaosReady(client))) return null;
  const totals = await chaosTotals(client);
  const team = audience === "team";
  const columns = team ? "team_items AS items, team_weight AS weight, team_sum AS sum" : "items, weight, sum";
  const where = team ? "team_exists = 1 AND team_weight > 0" : "weight > 0";
  const candidates = await client.query(
    `SELECT folder, ${columns} FROM tree_chaos WHERE ${where} AND ${team ? "team_sum" : "sum"} > 0
     ORDER BY ${team ? "team_sum" : "sum"} DESC LIMIT ?1`,
    [limit * 4],
  );
  // A team reader only ever sees folders with a team note beneath them (`team_exists`).
  const folders = candidates
    .slice(0, limit)
    .map((row) => ({
      folder: row.folder,
      items: Number(row.items),
      chaos: Number(row.weight) > 0 ? Number(row.sum) / Number(row.weight) : 0,
      share: Number(row.sum),
    }));
  const long = await client.query(
    `SELECT t.path AS path, json_extract(p.props, '$.lines') AS lines,
            json_extract(p.props, '$.properties.type') AS type, json_extract(p.props, '$.properties.generated') AS generated
     FROM tree_props AS p JOIN tree AS t ON t.path = p.path
     WHERE json_extract(p.props, '$.lines') > 1000 ORDER BY lines DESC LIMIT ?1`,
    [limit * 4],
  );
  const longNotes = long
    .filter((row) => !isArchived(row.path) && !isExempt(row.path, row.type, row.generated) && visible(row.path))
    .slice(0, 3)
    .map((row) => ({ path: row.path, lines: Number(row.lines) }));
  const weekAgo = await chaosOn(client, 7, audience, now);
  return { score: team ? totals.team : totals.all, weekAgo, folders, longNotes };
}
