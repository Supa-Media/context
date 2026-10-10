/**
 * The tree's properties: each note's front matter, first heading and first
 * paragraph, kept beside the tree table in the context's own search database,
 * so a folder List or Board is one query instead of a read of every note.
 *
 * ## Why it exists
 *
 * A project Board groups notes by `status:` and a List shows `owner:`; both
 * live inside each note. Read from the bucket, that was every note's text on
 * every open, which took minutes for a project folder (2026-10-08). The owner
 * chose to store the front matter beside the tree ("lets go ahead and do
 * both", 2026-10-09) so a folder of any size answers in one query.
 *
 * ## What a row is
 *
 * `path`, the `version` it was parsed at (the tree row's etag), and `props`:
 * `{ properties, heading, lede }` as JSON, parsed by the same `noteProperties`,
 * `noteHeading` and `noteLede` every other reader uses, so the table, a List
 * read from the bucket and a device's copy agree. An encrypted note keeps no
 * props, only `encrypted = 1`: its front matter is inside the ciphertext, and
 * a List leaves it out as it always has.
 *
 * ## Never trusted blindly
 *
 * A row whose version differs from its tree row's is **stale**, and a reader
 * reads that note again from the bucket and fixes the row before answering
 * (`folderNotes` in the control plane). So a write that never reached this
 * table costs one read, never a wrong status on screen. A fill pass parses
 * every note once after a sweep, as the links table's does.
 *
 * ## What it never decides
 *
 * Who may see anything. Rows are filtered by `canSee` over the live
 * `privacy.md` before a value leaves the barrier; the table stores no
 * visibility. It holds note text (front matter and a sentence), as the search
 * projection in the same database already does, and like it is a disposable
 * derivative: deleting the database loses nothing.
 */

import { noteHeading, noteProperties } from "../lists/properties.js";
import { noteLede } from "../lists/lede.js";
import { isEncryptedNote } from "../encryption/format.js";
import { countLines } from "../chaos/rubric.js";
import { TREE_STATEMENTS, readTreeState, setStateStatements } from "./table.js";

/** The table. Created with the tree's, so an existing database needs no migration step. */
export const PROP_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS tree_props (
     path      TEXT PRIMARY KEY,
     version   TEXT,
     encrypted INTEGER NOT NULL DEFAULT 0,
     props     TEXT
   ) WITHOUT ROWID`,
]);

/** `index_state` key: every note in the tree has been parsed at least once. */
export const PROPS_READY = "tree_props_ready";

/** Notes one fill pass reads. */
export const PROP_FILL_NOTES = 200;

/** Notes read at once by a fill pass. */
const PROP_FILL_CONCURRENCY = 8;

/** Rows one page of a folder read returns, before anybody's `canSee`. */
export const FOLDER_PAGE_ROWS = 2_000;

/** `.md` and nothing else is a note a List draws. */
const IS_NOTE_SQL = "substr(t.path, -3) = '.md'";

/**
 * What one note's text becomes: its properties, first heading and first
 * paragraph, or `null` for an encrypted note.
 *
 * @param {string} text
 * @returns {{ properties: Record<string, unknown>, heading: string | null, lede: string | null, lines?: number } | null}
 */
export function propsOf(text) {
  if (typeof text !== "string") return { properties: {}, heading: null, lede: null, lines: 0 };
  if (isEncryptedNote(text)) return null;
  return {
    properties: { ...noteProperties(text) },
    heading: noteHeading(text),
    lede: noteLede(text),
    // The chaos score's long-note rule (`chaos/rubric.js`).
    lines: countLines(text),
  };
}

/** Record one note's props, parsed from `text`, at `version`. */
export function propWriteStatement(path, version, text) {
  const props = propsOf(text);
  return {
    sql: `INSERT INTO tree_props (path, version, encrypted, props) VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT(path) DO UPDATE SET version = excluded.version, encrypted = excluded.encrypted, props = excluded.props`,
    params: [
      path,
      typeof version === "string" && version !== "" ? version : null,
      props === null ? 1 : 0,
      props === null ? null : JSON.stringify(props),
    ],
  };
}

/** Rows whose note has left the tree, removed. */
export const PRUNE_PROP_STATEMENTS = Object.freeze([
  { sql: "DELETE FROM tree_props WHERE path NOT IN (SELECT path FROM tree)", params: [] },
]);

/**
 * A note is parsed when its props row carries the version its tree row does.
 * A tree row with no version cannot say it changed, so any parse counts.
 */
const STALE_SQL = "(p.path IS NULL OR (t.etag IS NOT NULL AND t.etag IS NOT p.version))";
/** A row parsed before notes' lengths were kept, read once more for the chaos score. */
const NO_LINES_SQL = "(p.encrypted = 0 AND json_extract(p.props, '$.lines') IS NULL)";
const UNPARSED_SQL = `FROM tree AS t LEFT JOIN tree_props AS p ON p.path = t.path
  WHERE ${IS_NOTE_SQL} AND (${STALE_SQL} OR ${NO_LINES_SQL})`;

/** Notes the table has not parsed at their current version, in path order. */
export async function unparsedProps(client, limit) {
  return await client.query(`SELECT t.path AS path, t.etag AS etag ${UNPARSED_SQL} ORDER BY t.path LIMIT ?1`, [
    Math.max(1, limit),
  ]);
}

/**
 * One fill pass: read up to `limit` unparsed notes from the bucket and record
 * their props. A pass that leaves none unparsed prunes the rows of notes that
 * have left and marks the table ready.
 *
 * @param {{ get: Function }} store the context's bucket, as the barrier opened it
 * @param {{ query: Function, runAll: Function }} client its search database
 * @returns {Promise<{ read: number, remaining: number, ready: boolean }>}
 */
export async function propFillPass(store, client, { limit = PROP_FILL_NOTES } = {}) {
  await client.runAll([...TREE_STATEMENTS, ...PROP_STATEMENTS].map((sql) => ({ sql, params: [] })));
  const tree = await readTreeState(client);
  if (!tree.ready || tree.unsupported) return { read: 0, remaining: 0, ready: false };
  const due = await unparsedProps(client, limit);
  const finish = async () => {
    await client.runAll([...PRUNE_PROP_STATEMENTS, ...setStateStatements({ [PROPS_READY]: 1 })]);
  };
  if (due.length === 0) {
    await finish();
    return { read: 0, remaining: 0, ready: true };
  }
  const statements = [];
  for (let start = 0; start < due.length; start += PROP_FILL_CONCURRENCY) {
    const wave = due.slice(start, start + PROP_FILL_CONCURRENCY);
    const parsed = await Promise.all(
      wave.map(async ({ path, etag }) => {
        try {
          const object = await store.get(path);
          // Gone since the tree saw it: recorded empty at the tree's version,
          // and the sweep that takes the tree row away prunes this one.
          return propWriteStatement(path, etag, object ? await object.text() : "");
        } catch {
          // One unreadable note must not cost the rest; the next pass tries again.
          return null;
        }
      }),
    );
    for (const statement of parsed) if (statement !== null) statements.push(statement);
  }
  if (statements.length > 0) await client.runAll(statements);
  const left = await unparsedProps(client, 1);
  if (left.length > 0) return { read: due.length, remaining: left.length, ready: false };
  await finish();
  return { read: due.length, remaining: 0, ready: true };
}

/** Whether every note has been parsed once. A database with no props table yet has not. */
export async function readPropState(client) {
  try {
    const [row] = await client.query("SELECT value FROM index_state WHERE key = ?1", [PROPS_READY]);
    return { ready: row?.value === "1" };
  } catch {
    return { ready: false };
  }
}

/**
 * The upper bound of the keys under `prefix` (`"a/"` → `"a0"`): "0" is the
 * byte after "/", so this is the first key that is not under it.
 */
function prefixEnd(prefix) {
  return `${prefix.slice(0, -1)}0`;
}

/**
 * One page of the notes under `folder`, in path order after `after`: each
 * note's tree version and time, and its props row, `stale` when the row is
 * missing or was parsed at another version. **Unfiltered**: the caller applies
 * `canSee` before any value is used or returned.
 *
 * @returns {Promise<{ path: string, etag: string | null, uploaded: number | null, stale: boolean, encrypted: boolean, props: string | null }[]>}
 */
export async function folderPropRows(client, { folder, after, limit = FOLDER_PAGE_ROWS }) {
  const prefix = folder === "" ? "" : `${folder}/`;
  const bounds = [];
  const params = [];
  if (prefix !== "") {
    params.push(prefix, prefixEnd(prefix));
    bounds.push(`t.path >= ?${params.length - 1}`, `t.path < ?${params.length}`);
  }
  if (after !== undefined && after !== "") {
    params.push(after);
    bounds.push(`t.path > ?${params.length}`);
  }
  params.push(Math.max(1, limit));
  const rows = await client.query(
    `SELECT t.path AS path, t.etag AS etag, t.uploaded AS uploaded,
            ${STALE_SQL} AS stale, coalesce(p.encrypted, 0) AS encrypted, p.props AS props
     FROM tree AS t LEFT JOIN tree_props AS p ON p.path = t.path
     WHERE ${[IS_NOTE_SQL, ...bounds].join(" AND ")}
     ORDER BY t.path LIMIT ?${params.length}`,
    params,
  );
  return rows.map((row) => ({
    path: row.path,
    etag: typeof row.etag === "string" ? row.etag : null,
    uploaded: typeof row.uploaded === "number" ? row.uploaded : null,
    stale: Number(row.stale) === 1,
    encrypted: Number(row.encrypted) === 1,
    props: typeof row.props === "string" ? row.props : null,
  }));
}
