/**
 * What a workspace object's notes say about themselves: each note's links and
 * its props (front matter, inline tags, first heading, first paragraph, line
 * count), kept in the object beside the text they are read from (decided by
 * the owner, 2026-11-02; `docs/decisions/storage-and-credentials/facts-in-objects.md`).
 *
 * The control plane kept these for every workspace (`apps/convex/functions/lib/nodes/facts.ts`), filled by a chain
 * that read each changed note back out of the bucket. A workspace whose notes live in its object already holds the
 * text, so here the facts are a cache of it: read again whenever a note's stored etag differs from the one its facts
 * were read at, at the moment somebody asks, so an answer is never older than the text. Nothing here is the only copy
 * of anything; dropping both tables loses nothing.
 *
 * Parsed by the same `linkRowsOf` and `propsOf` the control plane runs (`tree/links.js`, `tree/props.js`), so the two
 * agree on what a note links to and what a List shows. A link is kept by the note's key, never its path: a move is a
 * row change, and a note's links follow it without a write here, exactly as the control plane renames `source`.
 *
 * Every answer is judged by the caller's `sees` (the object's `canSee` over its own rows and rules,
 * `workspaceStore/serve.js`): a note the reader may not see is never named, and a hidden seed answers what a missing
 * one does.
 */

import { linkRowsOf } from "../tree/links.js";
import { bareNameOf } from "../tree/links.js";
import { propsOf } from "../tree/props.js";
import { resolveNeighbors } from "../tree/neighbors.js";
import { indexableText } from "../encryption/format.js";
import { isIndexableNote } from "../search/indexable.js";
import { isWorkspaceObjectKey } from "./api.js";
import { chaosExtraOf } from "../tree/chaosExtra.js";
import { folderJobsAnswer } from "./jobsAnswer.js";
import { dateFactAsks } from "./dateFacts.js";

/** Paths one props ask names (the control plane's `PROPS_AT_PATHS`). */
export const PROPS_ASK_PATHS = 100;
/** Renamed paths one links ask answers (the control plane's `MOVE_RENAMES_CAP`). */
export const LINK_ASK_NAMES = 2_000;
/** More notes without facts than this and a move reads every note (the control plane's `MOVE_UNPARSED_CAP`). */
export const UNPARSED_CAP = 500;
/** Bytes of props one note keeps; past it, the note has no props and counts as unparsed (`PROPS_BYTES`). */
export const PROPS_BYTES = 32_000;
/** Links one note keeps; past it, the note counts as unparsed so a move still reads it (`FACT_RECORD_ROWS`). */
export const LINK_ROWS = 2_000;
/** Link rows one side of a neighbors answer reads (`NEIGHBOR_READ_ROWS`). */
export const NEIGHBOR_ROWS = 4_000;
/** Notes one ask reads again before it answers; past it, the ask is not served and the control plane answers. */
export const READ_BUDGET = 2_000;
/** Longest path an ask may name. */
const PATH_LENGTH = 4096;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ws_facts (
    key TEXT PRIMARY KEY,
    etag TEXT NOT NULL,
    props TEXT,
    sealed INTEGER NOT NULL DEFAULT 0,
    whole INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS ws_links (key TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ws_links_key ON ws_links (key)`,
  `CREATE INDEX IF NOT EXISTS ws_links_target ON ws_links (kind, target)`,
];

/** Thrown for an ask the object will not answer. */
export class FactAskRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "FactAskRefused";
  }
}

const NOT_SERVED = Object.freeze({ served: false });
const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
/** The key a row's text is stored at, as `ws.read` finds it. */
const KEY = "COALESCE(r.storage_key, CASE WHEN r.note_id IS NULL THEN NULL ELSE 'notes/' || r.note_id || '.md' END)";

function pathList(value, cap) {
  if (!Array.isArray(value) || value.length > cap) throw new FactAskRefused(`an ask names at most ${cap} paths`);
  if (!value.every((entry) => typeof entry === "string" && entry !== "" && entry.length <= PATH_LENGTH)) throw new FactAskRefused("not a path");
  return [...new Set(value)];
}

/**
 * The facts half of a workspace object. `sql` is the object's SQLite; `objects` is its key store
 * (`texStore/objects.js`), whose `objects` table the stale check joins.
 */
export function workspaceFacts(sql, objects) {
  for (const statement of SCHEMA) sql.exec(statement);

  /** Every live note row, later rows winning a path: `{path, key, etag, parsed, whole}`. */
  function notes(where = "", ...binds) {
    const found = all(
      sql.exec(
        `SELECT r.path AS path, ${KEY} AS key, o.etag AS etag, f.etag AS parsed, f.whole AS whole
         FROM ws_rows r
         LEFT JOIN objects o ON o.key = ${KEY}
         LEFT JOIN ws_facts f ON f.key = ${KEY}
         WHERE r.gone = 0 AND r.kind = 'file' AND r.path LIKE '%.md' ${where}
         ORDER BY r.at`,
        ...binds,
      ),
    );
    const byPath = new Map();
    for (const note of found) byPath.set(note.path, note);
    return byPath;
  }

  const local = (note) => typeof note.key === "string" && isWorkspaceObjectKey(note.key) && typeof note.etag === "string";
  const stale = (note) => local(note) && note.parsed !== note.etag;
  /** Facts a reader can trust for this note: read at its current text, and not cut short. */
  const parsed = (note) => local(note) && note.parsed === note.etag && Number(note.whole) === 1;

  /** Read one note's text and keep what it says. */
  function read(note) {
    const found = objects.get(note.key, {});
    sql.exec("DELETE FROM ws_links WHERE key = ?", note.key);
    if (found === null || found.body === undefined) {
      sql.exec("DELETE FROM ws_facts WHERE key = ?", note.key);
      return;
    }
    const text = new TextDecoder().decode(found.body);
    const props = propsOf(text);
    // An encrypted note's links are inside its ciphertext: none kept, which is what a rewrite does with it too.
    const links = linkRowsOf(note.path, indexableText(text));
    const json = props === null ? null : JSON.stringify(props);
    const whole = links.length <= LINK_ROWS && (json === null || json.length <= PROPS_BYTES);
    for (const [kind, target] of links.slice(0, LINK_ROWS)) {
      if (kind === "path" || kind === "name") sql.exec("INSERT INTO ws_links (key, kind, target) VALUES (?, ?, ?)", note.key, kind, target);
    }
    sql.exec(
      `INSERT INTO ws_facts (key, etag, props, sealed, whole) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, props = excluded.props, sealed = excluded.sealed, whole = excluded.whole`,
      note.key,
      found.etag,
      whole ? json : null,
      props === null ? 1 : 0,
      whole ? 1 : 0,
    );
    note.parsed = found.etag;
    note.etag = found.etag;
    note.whole = whole ? 1 : 0;
  }

  /** Read again every note whose text changed, up to the budget. Whether all are current now. */
  function catchUp(byPath, budget = READ_BUDGET) {
    let left = budget;
    for (const note of byPath.values()) {
      if (!stale(note)) continue;
      if (left === 0) return false;
      read(note);
      left -= 1;
    }
    // Facts of a key no longer stored go with it.
    sql.exec("DELETE FROM ws_facts WHERE key NOT IN (SELECT key FROM objects)");
    sql.exec("DELETE FROM ws_links WHERE key NOT IN (SELECT key FROM ws_facts)");
    return true;
  }

  /** Paths of live notes whose links name `target` as `kind`, at most `cap`. */
  function pointing(byKey, kind, target, cap = Infinity) {
    const keys = all(sql.exec(`SELECT DISTINCT key FROM ws_links WHERE kind = ? AND target = ?${Number.isFinite(cap) ? " LIMIT ?" : ""}`, kind, target, ...(Number.isFinite(cap) ? [cap] : [])));
    return keys.map((row) => byKey.get(row.key)).filter((path) => typeof path === "string");
  }

  function keyed(byPath) {
    const byKey = new Map();
    for (const note of byPath.values()) if (typeof note.key === "string") byKey.set(note.key, note.path);
    return byKey;
  }

  /** Every note's facts current, or `false` when more changed than one ask reads. */
  const current = () => {
    const byPath = notes();
    return catchUp(byPath) ? byPath : null;
  };

  return {
    // `dates` and `dateGaps`: what a note's date properties are filled from (`dateFacts.js`).
    ...dateFactAsks({ sql, key: KEY, notes, current, catchUp, parsed, stale, read }),

    /**
     * Unfiltered rows for the control plane's readers (`OBJECT_FACT_ROW_ASKS`).
     * - `props` with `paths`: `{props: [{path, version, sealed, props}]}`, a note without facts absent.
     * - `links`: `{links: [[source, kind, target]], unparsed}`, every link of every live note, at their paths now.
     * - `chaos`: `{extras: [{path, lines, exempt, review}]}`, the notes the score needs more than a key for.
     * - `candidates` with `sources` and `names`: a move's link candidates, as the `links` ask answers them, unfiltered.
     * - `linking` with `paths`: `{linking: [path]}`, the named notes that hold links of their own (the control plane's
     *   `nodeLinkSources.linking`), and every named note whose facts cannot be trusted, so a move still reads it.
     * - `neighborRows` with `path`: `{rows: {present, current, links, byPath, byName}}`, that note's links and the notes
     *   pointing at it by path and by bare name, unfiltered (the control plane's `nodeFacts.neighbors`).
     * `{served: false}` when more changed than one ask reads.
     */
    rows(fields) {
      if (fields.ask === "props") return { served: true, ...this.props({ paths: fields.paths }, () => true) };
      if (fields.ask === "candidates") return this.links({ sources: fields.sources, names: fields.names }, () => true);
      if (fields.ask === "linking") return { served: true, linking: this.linking({ paths: fields.paths }) };
      if (fields.ask === "neighborRows") return this.neighborRows({ path: fields.path });
      const byPath = current();
      if (byPath === null) return NOT_SERVED;
      if (fields.ask === "links") {
        const byKey = keyed(byPath);
        const links = [];
        for (const row of all(sql.exec("SELECT key, kind, target FROM ws_links ORDER BY key"))) {
          const source = byKey.get(row.key);
          if (typeof source === "string") links.push([source, row.kind, row.target]);
        }
        return { served: true, links, unparsed: [...byPath.values()].filter((note) => !parsed(note)).length };
      }
      if (fields.ask === "chaos") {
        const extras = [];
        for (const note of byPath.values()) {
          if (!parsed(note)) continue;
          const row = all(sql.exec("SELECT props FROM ws_facts WHERE key = ?", note.key))[0];
          const extra = chaosExtraOf(note.path, row?.props ?? null);
          if (extra !== null) extras.push({ path: note.path, ...extra });
        }
        return { served: true, extras };
      }
      throw new FactAskRefused("not a facts ask");
    },

    /**
     * `{ask: "props", paths}`: each named note the reader may see, with its props (`propsOf` as JSON) at the
     * version they were read at; a sealed note's props are `null`; a note with no facts is absent.
     */
    props({ paths }, sees) {
      const asked = pathList(paths, PROPS_ASK_PATHS);
      const props = [];
      for (const path of asked) {
        const note = notes("AND r.path = ?", path).get(path);
        // Judged before it is read, so a path the reader may not see is never read.
        if (!note || !sees(path)) continue;
        if (stale(note)) read(note);
        if (!parsed(note)) continue;
        const row = all(sql.exec("SELECT props, sealed FROM ws_facts WHERE key = ?", note.key))[0];
        if (!row) continue;
        props.push({ path, version: note.etag, sealed: Number(row.sealed) === 1, props: row.props ?? null });
      }
      return { served: true, props };
    },

    /**
     * Which of `paths` hold links of their own, read at their current text: what a move's rewrite asks of the notes
     * it moved, whose relative links change with them. A named note whose facts cannot be trusted (its text is
     * elsewhere, or it holds more than one note keeps) is answered as linking, so it is read rather than skipped.
     * Unfiltered: only the control plane's readers ask it, and they judge every path.
     */
    linking({ paths }) {
      const asked = pathList(paths, LINK_ASK_NAMES);
      const found = [];
      for (const path of asked) {
        const note = notes("AND r.path = ?", path).get(path);
        if (!note) continue;
        if (stale(note)) read(note);
        if (!parsed(note) || all(sql.exec("SELECT 1 AS one FROM ws_links WHERE key = ? LIMIT 1", note.key)).length > 0) found.push(path);
      }
      return found;
    },

    /**
     * `{ask: "links", sources, names}`: the notes pointing at what a move renamed, by path or bare name, and every
     * note whose facts cannot be trusted (`unparsed`: its text is elsewhere, or it holds more than one note keeps).
     * `candidates: null` past `UNPARSED_CAP`, and the rewrite reads every note.
     */
    links({ sources, names }, sees) {
      const paths = pathList(sources, LINK_ASK_NAMES);
      const bare = pathList(names, LINK_ASK_NAMES);
      if (paths.length + bare.length > LINK_ASK_NAMES) throw new FactAskRefused(`an ask names at most ${LINK_ASK_NAMES} paths`);
      const byPath = notes();
      if (!catchUp(byPath)) return NOT_SERVED;
      const unparsed = [...byPath.values()].filter((note) => !parsed(note)).map((note) => note.path);
      if (unparsed.length > UNPARSED_CAP) return { served: true, candidates: null };
      const byKey = keyed(byPath);
      const found = new Set();
      for (const target of paths) for (const path of pointing(byKey, "path", target)) found.add(path);
      for (const target of bare) for (const path of pointing(byKey, "name", target)) found.add(path);
      return { served: true, candidates: { pointing: [...found].filter(sees), unparsed: unparsed.filter(sees) } };
    },

    /**
     * The rows a neighbors answer is resolved from, unfiltered, in the control plane's `nodeFacts.neighbors` shape:
     * the control plane judges each path itself (`lib/nodes/gatewayFacts.ts`), when it answers for a reader the
     * object is behind for.
     */
    neighborRows({ path }) {
      const [seed] = pathList([path], 1);
      const byPath = notes();
      if (!catchUp(byPath)) return NOT_SERVED;
      const byKey = keyed(byPath);
      const own = byPath.get(seed) ?? null;
      const links = own === null ? [] : all(sql.exec("SELECT kind, target FROM ws_links WHERE key = ? LIMIT ?", own.key, NEIGHBOR_ROWS));
      return {
        served: true,
        rows: {
          present: own !== null,
          current: own !== null && parsed(own),
          links: links.map(({ kind, target }) => ({ kind, target })),
          byPath: pointing(byKey, "path", seed, NEIGHBOR_ROWS),
          byName: pointing(byKey, "name", bareNameOf(seed), NEIGHBOR_ROWS),
        },
      };
    },

    /**
     * `{ask: "neighbors", path}`: that note's links and backlinks among the notes the reader may see
     * (`tree/neighbors.js`). A seed the reader may not see answers exactly what a missing one does, after the same work.
     */
    neighbors({ path }, sees) {
      const [seed] = pathList([path], 1);
      const byPath = notes();
      if (!catchUp(byPath)) return NOT_SERVED;
      const visible = new Set();
      for (const note of byPath.keys()) if (isIndexableNote(note) && sees(note)) visible.add(note);
      const byKey = keyed(byPath);
      const own = byPath.get(seed) ?? null;
      const links = own === null ? [] : all(sql.exec("SELECT kind, target FROM ws_links WHERE key = ? LIMIT ?", own.key, NEIGHBOR_ROWS));
      const rows = {
        links: links.map(({ kind, target }) => ({ kind, target })),
        byPath: pointing(byKey, "path", seed, NEIGHBOR_ROWS),
        byName: pointing(byKey, "name", bareNameOf(seed), NEIGHBOR_ROWS),
      };
      // Resolved either way, so a hidden seed costs what a visible one does.
      const found = resolveNeighbors(seed, rows, visible);
      if (!visible.has(seed)) return { served: true, neighbors: { links: [], backlinks: [], complete: true } };
      return { served: true, neighbors: { ...found, complete: parsed(own) } };
    },

    /**
     * `{ask: "jobs"}`: which folder does each built-in job, and the root folders, as the reader may see them
     * (`jobsAnswer.js`, Convex's `gatewayFacts` `jobs` branch). `folderSees` is the reader's `folderVisibleAtScope`.
     */
    jobs(_fields, _sees, folderSees) {
      const rows = all(sql.exec("SELECT path, kind, role FROM ws_rows WHERE gone = 0 AND kind = 'folder'"));
      return folderJobsAnswer(rows.map((row) => ({ path: row.path, kind: row.kind, role: typeof row.role === "string" ? row.role : null })), folderSees);
    },
  };
}

/**
 * The asks a workspace object answers itself. Every other ask is the control plane's. `forwarding` is answered from
 * the ledger copy beside these (`forwardingRows.js`), not from the notes.
 */
export const OBJECT_FACT_ASKS = new Set(["props", "links", "neighbors", "jobs", "forwarding", "dates", "dateGaps"]);

/**
 * The asks the control plane's own readers make through the door (`ws.facts.rows`): unfiltered, like the control
 * plane's internal queries they stand in for (`nodeFacts.propsAt`, `nodeFacts.page`, `nodeChaos.extras`,
 * `nodeFacts.neighbors`, `nodeLinkSources.linking`), because
 * every caller judges each path itself. Never sent on a person's behalf by the gateway.
 */
export const OBJECT_FACT_ROW_ASKS = new Set(["props", "links", "chaos", "candidates", "linking", "neighborRows"]);
