/**
 * A workspace object's own word index over the notes it holds: the same tables, rows and queries as the per-context
 * search database (`search/d1/project.js`, `search/d1/query.js`), kept in the object beside the text they are read from,
 * so a search is one call to the object instead of a round trip to D1 over Cloudflare's HTTP API (decided 2026-11-03,
 * Dev's "every read and write under 0.1 s"; `docs/decisions/search/object-word-index.md`).
 *
 * A cache of the text, like the facts beside it (`facts.js`): SQLite triggers on the rows and on the notes' text note
 * every change, whoever wrote it, and before a search answers each changed row is looked at again, so an answer is
 * never older than the notes. A workspace with more to catch up than one search may spend (`QUERY_ROWS`,
 * `QUERY_BYTES`) answers `served: false`, the gateway asks the search database as before, and `ws.search.build` catches
 * up behind the response, a bounded slice a call. Nothing here is the only copy of anything; dropping these tables
 * loses nothing.
 *
 * **The two tables are for corpus statistics, not access** (`docs/decisions/search/backfill-and-switch.md`): a note is
 * indexed in the team table only where the member rules make it `team`, so a team reader's ranking is computed over
 * team notes alone. Which results a reader may keep is the gateway's live `canSee`, after this answers, exactly as for
 * the search database.
 */

import { effectiveVisibility } from "../privacy/engine.js";
import { indexableText } from "../encryption/format.js";
import { isIndexableNote } from "../search/indexable.js";
import { deleteStatements, FTS_TABLE, projectNote, upsertStatements } from "../search/d1/project.js";
import { searchParams, searchSql, withWholeLines } from "../search/d1/query.js";
import { parsedRules } from "./serve.js";
import { TEX_TABLES, texObjects } from "../texStore/objects.js";
import { changeLog, PERSON_TEX_KEY } from "./changeLog.js";

/** A person's own Tex note key (`store/texRouting.js`): its text is in this object's Tex tables, at the key's rest. */
/**
 * Where a live row's text is in this object: its own notes (`notes/<id>.md`), or the person's Tex tables for a Tex note
 * of theirs; `null` for anything else (a group chat's home note, kept in that chat's own object, is not indexed here).
 */
function textAt(row) {
  const key = row.storage_key ?? (typeof row.note_id === "string" ? `notes/${row.note_id}.md` : null);
  if (typeof key !== "string") return null;
  if (key.startsWith("notes/")) return { key, tex: false };
  const tex = PERSON_TEX_KEY.exec(key);
  return tex ? { key: tex[1], tex: true } : null;
}

/**
 * What one search may spend catching up before it answers: at most this many changed rows, and this much note text
 * read and indexed (about 1.5 ms per 2.4 KB on node:sqlite, several times that in production). With more waiting, the
 * search is not served here. Text, not time, bounds it: a Durable Object's clock does not move while it computes.
 */
export const QUERY_ROWS = 32;
export const QUERY_BYTES = 32 * 1024;
/**
 * What one `ws.search.build` call spends behind a response. Kept short, because the object answers nothing else while
 * it runs; the gateway sends the calls one after another (`search/objectSearch.js`), and other calls are answered
 * between them. A note longer than this is still indexed whole, alone in its call.
 */
export const BUILD_ROWS = 400;
export const BUILD_BYTES = 64 * 1024;
/** The index's own layout; an index from an earlier one is emptied and built again. */
// 4: file names in the headings column and word forms asked at query time (2026-11-04).
const LAYOUT = "4";
/** Queries one search sends (a strict, a relaxed and a name expression, over at most both tables). */
const MAX_ASKS = 6;
/** Rows one query may ask for (the gateway's `CHUNK_FETCH_CAP` is well under it). */
const MAX_LIMIT = 500;
/** Longest match expression or prefix taken. */
const MAX_TEXT = 4096;

/** The search database's own schema (`apps/convex/functions/lib/d1.ts` `SCHEMA_STATEMENTS`), less its `index_state`. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (
    path TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    visibility TEXT NOT NULL,
    title TEXT,
    uploaded TEXT,
    chunks INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS notes_by_visibility ON notes(visibility)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE.private} USING fts5(path UNINDEXED, ord UNINDEXED, title, headings, tags, body, tokenize='unicode61 remove_diacritics 2')`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE.team} USING fts5(path UNINDEXED, ord UNINDEXED, title, headings, tags, body, tokenize='unicode61 remove_diacritics 2')`,
  `CREATE TABLE IF NOT EXISTS ws_search_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Which row each indexed path came from, so a moved or removed row's old path is dropped.
  `CREATE TABLE IF NOT EXISTS ws_search_held (path TEXT PRIMARY KEY, row_id TEXT NOT NULL)`,
  // Each indexed chunk's rowid in its full-text table, so a note's chunks are removed by rowid: the tables' `path` is
  // UNINDEXED, and removing by it reads every chunk of every note.
  `CREATE TABLE IF NOT EXISTS ws_search_chunks (path TEXT NOT NULL, tbl TEXT NOT NULL, id INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ws_search_chunks_path ON ws_search_chunks (path)`,
  `CREATE INDEX IF NOT EXISTS ws_search_held_row ON ws_search_held (row_id)`,
];

const FTS_TABLES = Object.values(FTS_TABLE);
const TABLES = new Set(FTS_TABLES);
/** A statement into one of the full-text tables: whether it removes or adds, and which table. */
const FTS_STATEMENT = new RegExp(`^\\s*(DELETE FROM|INSERT INTO) (${FTS_TABLES.join("|")})\\b`);

export class SearchAskRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "SearchAskRefused";
  }
}

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/**
 * The word index over `sql`, beside `rows` (`rows.js`) and `objects` (`texStore/objects.js`, the notes' text).
 *
 * @param {{exec: (query: string, ...binds: unknown[]) => {toArray(): object[]}}} sql
 * @param {{rows: ReturnType<typeof import("./rows.js").workspaceRows>, objects: {get(key: string): object|null}}} held
 */
export function workspaceSearch(sql, { rows, objects }) {
  const log = changeLog(sql, "ws_search");
  const meta = (name) => all(sql.exec("SELECT value FROM ws_search_meta WHERE name = ?", name))[0]?.value ?? null;
  const setMeta = (name, value) => sql.exec("INSERT INTO ws_search_meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, value);
  /** Every note row to look at again: on a new layout, and when the member rules change every note's tier. */
  const allRowsDirty = () => log.markAll("SELECT row_id FROM ws_search_held");

  let ready = false;
  const schema = () => {
    if (!ready) {
      for (const statement of SCHEMA) sql.exec(statement);
      log.ensure();
      if (meta("layout") !== LAYOUT) {
        // An index from an earlier layout has no held paths to drop by: empty it and look at every row again.
        for (const table of ["notes", FTS_TABLE.private, FTS_TABLE.team, "ws_search_held", "ws_search_chunks"]) sql.exec(`DELETE FROM ${table}`);
        log.clearKeys();
        sql.exec("DELETE FROM ws_search_meta");
        allRowsDirty();
        setMeta("layout", LAYOUT);
      }
      ready = true;
    }
    log.ensure();
  };
  let texHeld = null;
  const texNotes = () => (texHeld ??= texObjects(sql, { tables: TEX_TABLES }));
  const etagOf = (where) => {
    const table = where.tex ? TEX_TABLES.objects : "objects";
    if (where.tex && !log.texReady) return undefined;
    const held = all(sql.exec(`SELECT etag, size FROM ${table} WHERE key = ?`, where.key))[0];
    return held === undefined ? undefined : { etag: held.etag, size: Number(held.size ?? 0) };
  };
  /**
   * Run the search database's own statements for `path` (`search/d1/project.js`), except that its chunks are removed
   * by the rowids kept for them, and each chunk inserted has its rowid kept.
   */
  const run = (path, statements) => {
    for (const table of FTS_TABLES) {
      sql.exec(`DELETE FROM ${table} WHERE rowid IN (SELECT id FROM ws_search_chunks WHERE path = ? AND tbl = ?)`, path, table);
    }
    sql.exec("DELETE FROM ws_search_chunks WHERE path = ?", path);
    for (const statement of statements) {
      const into = FTS_STATEMENT.exec(statement.sql);
      if (into?.[1] === "DELETE FROM") continue;
      sql.exec(statement.sql, ...statement.params);
      if (into?.[1] === "INSERT INTO") sql.exec("INSERT INTO ws_search_chunks (path, tbl, id) VALUES (?, ?, last_insert_rowid())", path, into[2]);
    }
  };
  const drop = (path) => {
    run(path, deleteStatements(path));
    sql.exec("DELETE FROM ws_search_held WHERE path = ?", path);
  };

  /**
   * Bring one row's entry up to it: the note text read, in bytes, or `null` where its text is longer than `room` and
   * it was left waiting.
   */
  const refresh = (id, rules, overrides, room) => {
    const live = all(sql.exec("SELECT path, storage_key, note_id, kind, gone FROM ws_rows WHERE id = ?", id))[0] ?? null;
    let want = null;
    if (live && Number(live.gone) === 0 && live.kind === "file" && isIndexableNote(live.path)) {
      const where = textAt(live);
      const text = where === null ? undefined : etagOf(where);
      if (text !== undefined) want = { path: live.path, ...where, etag: text.etag, size: text.size, visibility: effectiveVisibility(live.path, rules, overrides) };
    }
    for (const held of all(sql.exec("SELECT path FROM ws_search_held WHERE row_id = ?", id))) if (want === null || held.path !== want.path) drop(held.path);
    if (want === null) return 0;
    const was = all(sql.exec("SELECT version, visibility FROM notes WHERE path = ?", want.path))[0] ?? null;
    let read = 0;
    if (!was || was.version !== want.etag || was.visibility !== want.visibility) {
      if (want.size > room) return null;
      const found = (want.tex ? texNotes() : objects).get(want.key);
      if (found === null || found.body === undefined) {
        drop(want.path);
        return 0;
      }
      read = found.body.byteLength ?? 0;
      const content = indexableText(new TextDecoder().decode(found.body));
      const projected = projectNote(want.path, { version: want.etag, uploaded: null, visibility: want.visibility, content });
      run(want.path, upsertStatements(want.path, projected));
    }
    sql.exec("INSERT INTO ws_search_held (path, row_id) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET row_id = excluded.row_id", want.path, id);
    return read;
  };

  const waiting = () => log.pending();

  /**
   * Bring the index up to the notes, spending at most `rows` changed rows and `bytes` of note text, and say how many
   * changes are still waiting (`null`: no member rules held, so no note's tier can be told).
   */
  const catchUp = ({ rows: maxRows, bytes, whole = false }) => {
    schema();
    const held = rows.rules("member");
    if (held === null) return null;
    const stamp = JSON.stringify([held.accessVersion ?? null, held.etag ?? null]);
    if (meta("rules") !== stamp) {
      allRowsDirty();
      setMeta("rules", stamp);
    }
    const { rules, overrides } = parsedRules(held);
    log.keysToRows();
    let spent = 0;
    let done = 0;
    while (done < maxRows && spent < bytes) {
      const ids = log.take(Math.min(50, maxRows - done));
      if (ids.length === 0) break;
      let full = false;
      for (const id of ids) {
        // A note longer than a build's whole budget is indexed alone in its call; a search never takes one inline.
        const room = whole && spent === 0 ? Infinity : bytes - spent;
        const read = refresh(id, rules, overrides, room);
        if (read === null) {
          full = true;
          break;
        }
        spent += read;
        log.done(id);
        done += 1;
        if (spent >= bytes) break;
      }
      if (full) break;
    }
    return waiting();
  };

  return {
    /** Catch up behind a response: `BUILD_ROWS` rows and `BUILD_BYTES` of text at most. */
    catchUp(budget = { rows: BUILD_ROWS, bytes: BUILD_BYTES, whole: true }) {
      return catchUp(budget);
    },

    /**
     * Run a search's queries, once the index is current: `{served: true, answers}`, one array of rows per ask, in
     * order, as the search database answers them; or `{served: false, waiting}` with more to catch up than one search
     * may spend. Each ask names one of the two tables, its match expression, a folder prefix and a row cap; the SQL is
     * built here (`searchSql`), never taken from the caller.
     */
    search(asks) {
      if (!Array.isArray(asks) || asks.length === 0 || asks.length > MAX_ASKS) throw new SearchAskRefused(`a search sends 1 to ${MAX_ASKS} queries`);
      const checked = asks.map((ask) => {
        if (!ask || typeof ask !== "object" || !TABLES.has(ask.table)) throw new SearchAskRefused("a query names one of the search tables");
        if (typeof ask.match !== "string" || ask.match === "" || ask.match.length > MAX_TEXT) throw new SearchAskRefused("a query needs its match expression");
        const prefix = ask.prefix ?? "";
        if (typeof prefix !== "string" || prefix.length > MAX_TEXT) throw new SearchAskRefused("not a prefix");
        const limit = Number(ask.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new SearchAskRefused(`a query asks for 1 to ${MAX_LIMIT} rows`);
        return { table: ask.table, match: ask.match, options: { limit, prefix, firstChunk: ask.firstChunk === true } };
      });
      schema();
      // Far behind (a first build, a change of rules): not served, and nothing spent here; the build catches up.
      const before = waiting();
      if (before > 2 * QUERY_ROWS) return { served: false, waiting: before };
      const left = catchUp({ rows: QUERY_ROWS, bytes: QUERY_BYTES });
      if (left === null || left > 0) return { served: false, waiting: left };
      return { served: true, answers: checked.map(({ table, match, options }) => all(sql.exec(searchSql(table, options), ...searchParams(match, options))).map(withWholeLines)) };
    },
  };
}
