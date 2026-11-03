/**
 * A workspace object's own word index over the notes it holds: the same tables, rows and queries as the per-context
 * search database (`search/d1/project.js`, `search/d1/query.js`), kept in the object beside the text they are read from,
 * so a search is one call to the object instead of a round trip to D1 over Cloudflare's HTTP API (decided 2026-11-03,
 * Dev's "every read and write under 0.1 s"; `docs/decisions/search/object-word-index.md`).
 *
 * A cache of the text, like the facts beside it (`facts.js`): before a search answers, every note whose text, path or
 * tier changed since it was indexed is indexed again, so an answer is never older than the notes. A workspace with
 * more to catch up than one search may spend (`QUERY_BUDGET`) answers `served: false`, the gateway asks the search
 * database as before, and `ws.search.build` catches up behind the response, `BUILD_BUDGET` notes a call. Nothing here
 * is the only copy of anything; dropping these tables loses nothing.
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
import { searchParams, searchSql } from "../search/d1/query.js";
import { parsedRules } from "./serve.js";
import { TEX_TABLES, texObjects } from "../texStore/objects.js";

/** A person's own Tex note key (`store/texRouting.js`): its text is in this object's Tex tables, at the key's rest. */
const PERSON_TEX_KEY = /^tex\/person:[A-Za-z0-9_-]{1,64}\/(notes\/[^/]+\.md)$/;

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
 * Notes indexed again before a search answers; with more waiting, the search is not served here. About 1.5 ms a note
 * (5,000 notes of 2.4 KB on node:sqlite), so a search pays at most ~12 ms for notes written since the last one.
 */
export const QUERY_BUDGET = 8;
/**
 * Notes one `ws.search.build` call indexes, behind a response: about 0.15 s, kept short because the object answers
 * nothing else while it runs, and the gateway sends the calls one after another (`search/objectSearch.js`).
 */
export const BUILD_BUDGET = 100;
/** Queries one search sends (a strict and a relaxed expression, over at most both tables). */
const MAX_ASKS = 4;
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
];

const TABLES = new Set(Object.values(FTS_TABLE));

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
  let ready = false;
  const schema = () => {
    if (ready) return;
    for (const statement of SCHEMA) sql.exec(statement);
    ready = true;
  };
  // The person's Tex notes, where this is a personal workspace's object (`texHost.js`): in tables of their own here.
  let texHeld = null;
  const texTable = () => all(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", TEX_TABLES.objects)).length > 0;
  const texNotes = () => (texHeld ??= texObjects(sql, { tables: TEX_TABLES }));
  const meta = (name) => all(sql.exec("SELECT value FROM ws_search_meta WHERE name = ?", name))[0]?.value ?? null;
  const setMeta = (name, value) => sql.exec("INSERT INTO ws_search_meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, value);

  /**
   * What the index was last brought up to: the notes' text (count, newest and summed write times), the rows (count,
   * newest and summed change times, how many are gone) and the member rules' version. Equal to the stored one,
   * nothing has changed and no note is read. A row whose path changed with no new time would not move it; every
   * row change carries its writer's clock (`rows.js`).
   */
  const signature = (held) => {
    // Sums as well as the newest: a row moved by a writer whose clock is behind the newest row's still moves the sum.
    const textOf = (table) => all(sql.exec(`SELECT COUNT(*) AS n, MAX(uploaded) AS at, SUM(uploaded) AS total FROM ${table} WHERE key >= 'notes/' AND key < 'notes0'`))[0] ?? {};
    const own = textOf("objects");
    const tex = texTable() ? textOf(TEX_TABLES.objects) : {};
    const tree = all(sql.exec("SELECT COUNT(*) AS n, MAX(at) AS at, SUM(at) AS total, SUM(gone) AS gone FROM ws_rows"))[0] ?? {};
    const numbers = [own.n, own.at, own.total, tex.n, tex.at, tex.total, tree.n, tree.at, tree.total, tree.gone].map((value) => Number(value ?? 0));
    return JSON.stringify([...numbers, held.accessVersion, held.etag ?? null]);
  };

  /**
   * Every note to index again (its text, path or tier changed, or it is new) and every path to drop, judged against
   * the live rows and the member rules. `null` where no member rules are held: a note's tier cannot be told.
   */
  const plan = () => {
    const held = rows.rules("member");
    if (held === null) return null;
    const stamp = signature(held);
    if (meta("signature") === stamp) return { stamp, todo: [], gone: [] };
    const { rules, overrides } = parsedRules(held);
    const indexed = new Map(all(sql.exec("SELECT path, version, visibility FROM notes")).map((row) => [row.path, row]));
    const etags = (table) => new Map(all(sql.exec(`SELECT key, etag FROM ${table} WHERE key >= 'notes/' AND key < 'notes0'`)).map((row) => [row.key, row.etag]));
    const own = etags("objects");
    const tex = texTable() ? etags(TEX_TABLES.objects) : new Map();
    const live = all(sql.exec("SELECT path, storage_key, note_id FROM ws_rows WHERE gone = 0 AND kind = 'file'"));
    const todo = [];
    const seen = new Set();
    for (const row of live) {
      if (!isIndexableNote(row.path) || seen.has(row.path)) continue;
      const where = textAt(row);
      const etag = where === null ? undefined : (where.tex ? tex : own).get(where.key);
      if (etag === undefined) continue;
      seen.add(row.path);
      const visibility = effectiveVisibility(row.path, rules, overrides);
      const was = indexed.get(row.path);
      if (!was || was.version !== etag || was.visibility !== visibility) todo.push({ path: row.path, ...where, etag, visibility });
    }
    const gone = [...indexed.keys()].filter((path) => !seen.has(path));
    return { stamp, todo, gone };
  };

  /** Index `notes` again and drop `gone`; the signature is kept only once nothing is left. */
  const apply = ({ stamp, todo, gone }, budget) => {
    const now = todo.slice(0, budget);
    for (const path of gone) for (const statement of deleteStatements(path)) sql.exec(statement.sql, ...statement.params);
    for (const note of now) {
      const found = (note.tex ? texNotes() : objects).get(note.key);
      if (found === null || found.body === undefined) {
        for (const statement of deleteStatements(note.path)) sql.exec(statement.sql, ...statement.params);
        continue;
      }
      const content = indexableText(new TextDecoder().decode(found.body));
      const projected = projectNote(note.path, { version: note.etag, uploaded: null, visibility: note.visibility, content });
      for (const statement of upsertStatements(note.path, projected)) sql.exec(statement.sql, ...statement.params);
    }
    const left = todo.length - now.length;
    if (left === 0) setMeta("signature", stamp);
    return left;
  };

  return {
    /**
     * Something it is read from changed (a note's text put or removed): the next answer plans again, whatever the
     * signature says. Covers a write in the same millisecond as the last, which the signature alone cannot see.
     */
    touched() {
      schema();
      sql.exec("DELETE FROM ws_search_meta WHERE name = 'signature'");
    },

    /**
     * Bring the index up to the notes, at most `budget` notes, and say how many are still waiting (`null`: no member
     * rules held, so nothing can be indexed).
     */
    catchUp(budget = BUILD_BUDGET) {
      schema();
      const planned = plan();
      if (planned === null) return null;
      return apply(planned, budget);
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
        return { table: ask.table, match: ask.match, options: { limit, prefix } };
      });
      const waiting = this.catchUp(QUERY_BUDGET);
      if (waiting === null || waiting > 0) return { served: false, waiting };
      return { served: true, answers: checked.map(({ table, match, options }) => all(sql.exec(searchSql(table, options), ...searchParams(match, options)))) };
    },
  };
}
