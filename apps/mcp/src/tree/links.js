/**
 * The tree's links: which note points at which, kept beside the tree table in
 * the context's own search database.
 *
 * ## What it is for
 *
 * Two readers, one table (decided by the owner, 2026-10-08):
 *
 *  - **The map** draws every note and the links between them. It used to read
 *    every shard of the search index on each visit (fifty-odd bucket reads for
 *    a 15,000-note workspace); now it is two queries.
 *  - **A move or rename** rewrites every link to what moved. It used to read
 *    every note in the bucket to find them; now it asks the table "which notes
 *    point at this", indexed by target, and reads only those.
 *
 * ## What a row is
 *
 * `(source, kind, target)`: a note, and what one of its links names, parsed
 * by the same `parseLinks` and `linkTargetOf` a rewrite runs (`links.js`), so
 * the notes found here are the notes a rewrite would change. `kind` is `path`
 * for a link that names a path (relative links resolved against the note's own
 * folder) and `name` for a bare `[[name]]`, which names a note only once the
 * whole bucket says which one carries it, so it is resolved when read, never
 * stored resolved.
 *
 * `tree_link_sources` records the version each note was parsed at. A note
 * whose tree row has another version has changed since and is **unparsed**: a
 * fill pass reads it again, and until then a move treats it as a candidate
 * whatever it held, so a stale row can cost a read but never a missed link.
 *
 * ## What it never decides
 *
 * Who may see anything. No note text and no visibility are stored. The map
 * still draws a note only if `canSee` passes and a link only if both ends
 * are drawn; a move still rewrites only notes its caller can see. Rows whose
 * source has left the tree are ignored by every read (`JOIN tree`) and pruned
 * by the next fill that finds nothing left to read.
 *
 * Like the tree, a disposable derivative: deleting the database loses nothing.
 */

import { linkTargetOf, parseLinks } from "../links.js";
import { indexableText } from "../encryption/format.js";
import { TREE_STATEMENTS, readTreeState, setStateStatements } from "./table.js";

/** The tables. Created with the tree's, so an existing database needs no migration step. */
export const LINK_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS tree_links (
     source TEXT NOT NULL,
     kind   TEXT NOT NULL,
     target TEXT NOT NULL,
     PRIMARY KEY (source, kind, target)
   ) WITHOUT ROWID`,
  // "Which notes point at this" is a lookup by target.
  "CREATE INDEX IF NOT EXISTS tree_links_by_target ON tree_links (target, kind)",
  `CREATE TABLE IF NOT EXISTS tree_link_sources (
     path    TEXT PRIMARY KEY,
     version TEXT
   ) WITHOUT ROWID`,
]);

/** `index_state` key: every note in the tree has been parsed at least once. */
export const LINKS_READY = "tree_links_ready";

/** Notes one fill pass reads. */
export const LINK_FILL_NOTES = 200;

/** Notes read at once by a fill pass. */
export const LINK_FILL_CONCURRENCY = 8;

/** Rows one read of the table returns. */
export const LINK_PAGE_ROWS = 5_000;

/** Pages of a whole-table read in flight at once. */
const PAGE_CONCURRENCY = 6;

/** Rows one insert carries in its JSON parameter. */
const WRITE_ROWS = 500;

/**
 * More unparsed notes than this and a move does not trust the table: reading
 * them all is no cheaper than the walk it replaces, so it walks.
 */
export const MOVE_UNPARSED_CAP = 500;

/** `.md` and nothing else is a note the map draws and a move reads. */
const IS_NOTE_SQL = "substr(path, -3) = '.md'";

/** The rows one note's text becomes, as `[kind, target]` pairs, each once. */
export function linkRowsOf(path, text) {
  if (typeof text !== "string" || text === "") return [];
  const seen = new Set();
  const rows = [];
  for (const link of parseLinks(text)) {
    const target = linkTargetOf(link, path);
    if (target === null) continue;
    const value = target.kind === "path" ? target.path : target.name;
    if (value === "" || value === path) continue;
    const key = `${target.kind}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([target.kind, value]);
  }
  return rows;
}

/** Replace one note's rows with those its text holds, at `version`. */
export function linkWriteStatements(path, version, text) {
  const rows = linkRowsOf(path, text);
  const statements = [
    { sql: "DELETE FROM tree_links WHERE source = ?1", params: [path] },
    {
      sql: `INSERT INTO tree_link_sources (path, version) VALUES (?1, ?2)
            ON CONFLICT(path) DO UPDATE SET version = excluded.version`,
      params: [path, typeof version === "string" && version !== "" ? version : null],
    },
  ];
  for (let index = 0; index < rows.length; index += WRITE_ROWS) {
    statements.push({
      sql: `INSERT OR IGNORE INTO tree_links (source, kind, target)
            SELECT ?1, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]')
            FROM json_each(?2) AS j WHERE true`,
      params: [path, JSON.stringify(rows.slice(index, index + WRITE_ROWS))],
    });
  }
  return statements;
}

/** Rows whose note has left the tree, removed. */
export const PRUNE_LINK_STATEMENTS = Object.freeze([
  { sql: "DELETE FROM tree_links WHERE source NOT IN (SELECT path FROM tree)", params: [] },
  { sql: "DELETE FROM tree_link_sources WHERE path NOT IN (SELECT path FROM tree)", params: [] },
]);

/**
 * A note is parsed when its source row carries the version its tree row does.
 * A tree row with no version cannot say it changed, so any parse counts.
 */
const UNPARSED_SQL = `FROM tree AS t LEFT JOIN tree_link_sources AS s ON s.path = t.path
  WHERE ${IS_NOTE_SQL.replace("path", "t.path")}
    AND (s.path IS NULL OR (t.etag IS NOT NULL AND t.etag IS NOT s.version))`;

/** Notes the table has not parsed at their current version, in path order. */
export async function unparsedNotes(client, limit) {
  return await client.query(`SELECT t.path AS path, t.etag AS etag ${UNPARSED_SQL} ORDER BY t.path LIMIT ?1`, [
    Math.max(1, limit),
  ]);
}

async function tableMissing(work) {
  try {
    return await work();
  } catch (error) {
    if (/no such table/i.test(String(error?.message ?? ""))) return null;
    throw error;
  }
}

/**
 * What the link table can be trusted for: whether the tree it hangs off is
 * whole, whether every note has been parsed once, and how many are behind.
 */
export async function readLinkState(client) {
  const tree = await readTreeState(client);
  const base = { treeReady: tree.ready && !tree.unsupported, dirty: tree.dirty, ready: false, unparsed: null };
  if (!base.treeReady) return base;
  const found = await tableMissing(async () => {
    const [row] = await client.query(
      `SELECT (SELECT value FROM index_state WHERE key = ?1) AS ready, (SELECT count(*) ${UNPARSED_SQL}) AS unparsed`,
      [LINKS_READY],
    );
    return row;
  });
  if (found === null || found === undefined) return base;
  return { ...base, ready: found.ready === "1", unparsed: Number(found.unparsed ?? 0) };
}

/**
 * One fill pass: read up to `limit` unparsed notes from the bucket and record
 * their links. A pass that leaves none unparsed prunes the rows of notes that
 * have left and marks the table ready.
 *
 * @param {{ get: Function }} store the context's bucket, as the barrier opened it
 * @param {{ query: Function, runAll: Function }} client its search database
 * @returns {Promise<{ read: number, remaining: number, ready: boolean }>}
 */
export async function linkFillPass(store, client, { limit = LINK_FILL_NOTES } = {}) {
  await client.runAll([...TREE_STATEMENTS, ...LINK_STATEMENTS].map((sql) => ({ sql, params: [] })));
  const tree = await readTreeState(client);
  if (!tree.ready || tree.unsupported) return { read: 0, remaining: 0, ready: false };
  const due = await unparsedNotes(client, limit);
  if (due.length === 0) {
    await client.runAll([...PRUNE_LINK_STATEMENTS, ...setStateStatements({ [LINKS_READY]: 1 })]);
    return { read: 0, remaining: 0, ready: true };
  }
  const statements = [];
  for (let start = 0; start < due.length; start += LINK_FILL_CONCURRENCY) {
    const wave = due.slice(start, start + LINK_FILL_CONCURRENCY);
    const parsed = await Promise.all(
      wave.map(async ({ path, etag }) => {
        try {
          const object = await store.get(path);
          // Gone since the tree saw it: recorded at the tree's version with
          // no links, and the sweep that notices it took the row away prunes it.
          if (!object) return linkWriteStatements(path, etag, "");
          // An encrypted note's links are inside its ciphertext: none recorded,
          // which is also what a rewrite does with it (it never rewrites one).
          const text = indexableText(await object.text());
          return linkWriteStatements(path, etag, text);
        } catch {
          // One unreadable note must not cost the rest; the next pass tries again.
          return [];
        }
      }),
    );
    for (const list of parsed) statements.push(...list);
  }
  if (statements.length > 0) await client.runAll(statements);
  const left = await unparsedNotes(client, 1);
  if (left.length > 0) return { read: due.length, remaining: left.length, ready: false };
  await client.runAll([...PRUNE_LINK_STATEMENTS, ...setStateStatements({ [LINKS_READY]: 1 })]);
  return { read: due.length, remaining: 0, ready: true };
}

async function pagesOf(client, countSql, pageSql, params = []) {
  const [counted] = await client.query(countSql, params);
  const total = Number(counted?.n ?? 0);
  const offsets = [];
  for (let offset = 0; offset < total; offset += LINK_PAGE_ROWS) offsets.push(offset);
  const rows = [];
  for (let start = 0; start < offsets.length; start += PAGE_CONCURRENCY) {
    const wave = offsets.slice(start, start + PAGE_CONCURRENCY);
    const pages = await Promise.all(
      wave.map((offset) => client.query(pageSql, [...params, LINK_PAGE_ROWS, offset])),
    );
    for (const page of pages) rows.push(...page);
  }
  return rows;
}

/**
 * Every note path in the tree, in order. Read a page at a time, several pages
 * at once: the time to a drawn map is round trips, not bytes.
 */
export async function treeNotePaths(client) {
  const rows = await pagesOf(
    client,
    `SELECT count(*) AS n FROM tree WHERE ${IS_NOTE_SQL}`,
    `SELECT path FROM tree WHERE ${IS_NOTE_SQL} ORDER BY path LIMIT ?1 OFFSET ?2`,
  );
  return rows.map((row) => row.path);
}

/** Every link whose note is still in the tree, as `[source, kind, target]`. */
export async function treeLinkRows(client) {
  const rows = await pagesOf(
    client,
    "SELECT count(*) AS n FROM tree_links AS l JOIN tree AS t ON t.path = l.source",
    `SELECT l.source AS source, l.kind AS kind, l.target AS target
     FROM tree_links AS l JOIN tree AS t ON t.path = l.source
     ORDER BY l.source, l.kind, l.target LIMIT ?1 OFFSET ?2`,
  );
  return rows.map((row) => [row.source, row.kind, row.target]);
}

/** `1-projects/x/overview.md` → `overview`: what a bare link to it is written as. */
export function bareNameOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/**
 * The notes a rewrite for these renames must read, from the table, or `null`
 * when the table cannot be trusted for it and the rewrite should walk as it
 * always did.
 *
 * `inventory` is every note in the tree with the renames applied: what a
 * bare link's name is resolved against, which must be the whole bucket and
 * not just the candidates. `candidates` is every note whose links name a
 * renamed path or its bare name, every renamed note itself (its relative
 * links change depth), and every note changed since it was parsed.
 *
 * @param {{ query: Function }} client
 * @param {Map<string, string>} renames source → destination
 * @returns {Promise<{ inventory: string[], candidates: Set<string> } | null>}
 */
export async function linkCandidates(client, renames) {
  try {
    const state = await readLinkState(client);
    if (!state.treeReady || state.dirty || !state.ready || state.unparsed === null) return null;
    if (state.unparsed > MOVE_UNPARSED_CAP) return null;
    const sources = [...renames.keys()];
    const names = [...new Set(sources.map(bareNameOf))];
    const [paths, pointing, unparsed] = await Promise.all([
      treeNotePaths(client),
      client.query(
        `SELECT DISTINCT l.source AS source FROM tree_links AS l JOIN tree AS t ON t.path = l.source
         WHERE (l.kind = 'path' AND l.target IN (SELECT value FROM json_each(?1)))
            OR (l.kind = 'name' AND l.target IN (SELECT value FROM json_each(?2)))`,
        [JSON.stringify(sources), JSON.stringify(names)],
      ),
      unparsedNotes(client, MOVE_UNPARSED_CAP + 1),
    ]);
    if (unparsed.length > MOVE_UNPARSED_CAP) return null;
    const inventory = new Set(paths);
    for (const [source, destination] of renames) {
      inventory.delete(source);
      if (destination.endsWith(".md")) inventory.add(destination);
    }
    const candidates = new Set();
    for (const row of pointing) candidates.add(renames.get(row.source) ?? row.source);
    for (const row of unparsed) candidates.add(renames.get(row.path) ?? row.path);
    for (const destination of renames.values()) candidates.add(destination);
    return { inventory: [...inventory], candidates };
  } catch {
    return null;
  }
}
