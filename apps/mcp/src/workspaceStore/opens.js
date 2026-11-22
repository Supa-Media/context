/**
 * HOW OFTEN EACH NOTE IS OPENED (Dev2, 2026-11-22: "count the number of times a note has actually been opened by the
 * user and a separate count for in total, and weight that heavily in nomination and ranking", and "AI search should
 * definitely be a separate metric ... count how many times it's opened, because a lot of times AI is discarding the
 * results that people open").
 *
 * One row per open, kept in the workspace's own object beside the note (Dev2, 2026-11-22: "keep the same count ...
 * and then extract different things about who's opening it ... through what platform, through what AI client, through
 * text, the user, was it a human"): when, who (the person behind it), whether a person opened it or an AI client read
 * it (`by`), on which surface (`app`, an AI client over `mcp`, or Tex over `text`), and which client (its id and the
 * name it registered). Every count a search ranks by is read from these rows, so a new signal is a new query over the
 * same log, never a new counter that starts at zero. Being returned by a search is never logged; only an open is.
 *
 * Counts are keyed by the note's row id, not its path, so a rename or a move keeps its history. A search asks only for
 * paths it already holds and was allowed to see (`search/config/nodes.js` `opens`), and gets back the asker's own count
 * and the totals, never who else opened what.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ws_open_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL, at INTEGER NOT NULL, who TEXT, by TEXT NOT NULL, surface TEXT NOT NULL, client TEXT, client_name TEXT)`,
  `CREATE INDEX IF NOT EXISTS ws_open_log_note ON ws_open_log (note)`,
];

/** Who opened a note: a person, or an AI client reading it. */
export const OPENERS = Object.freeze(["person", "ai"]);
/** Where: the Context app, an AI client over MCP, or Tex over text. */
export const SURFACES = Object.freeze(["app", "mcp", "text"]);
/** The most opens one call records (a benchmark world seeds a note's history in one call). */
export const MAX_RECORDED = 1000;
/** The most paths one search asks about. */
export const MAX_ASKED = 200;

export class OpensRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "OpensRefused";
  }
}

const isWho = (value) => typeof value === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(value);
const isName = (value) => typeof value === "string" && value.length > 0 && value.length <= 120;
const isPath = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;

/** The opens table over a Durable Object's `sql`. `now` is a clock, for the tests. */
export function workspaceOpens(sql, { now = () => Date.now() } = {}) {
  let ready = false;
  const schema = () => {
    if (ready) return;
    for (const statement of SCHEMA) sql.exec(statement);
    ready = true;
  };
  const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
  /** The live note row at `path`: its id, or null. */
  const noteAt = (path) => rows(sql.exec("SELECT id FROM ws_rows WHERE path = ? AND kind = 'file' AND gone = 0", path))[0]?.id ?? null;

  return {
    /**
     * One open (or `count` of the same, for a seeded history) of the note at `path`, logged with what is known of it.
     * A path with no live note is nothing.
     */
    record({ path, who = null, by, surface = by === "person" ? "app" : "mcp", client = null, clientName = null, count = 1 } = {}) {
      if (!isPath(path)) throw new OpensRefused("an open names the note's path");
      if (!OPENERS.includes(by)) throw new OpensRefused(`an open is by one of ${OPENERS.join(", ")}`);
      if (!SURFACES.includes(surface)) throw new OpensRefused(`an open is on one of ${SURFACES.join(", ")}`);
      if (by === "person" && !isWho(who)) throw new OpensRefused("a person's open names who");
      if (who !== null && !isWho(who)) throw new OpensRefused("not a person");
      if (client !== null && !isWho(client)) throw new OpensRefused("not a client id");
      if (clientName !== null && !isName(clientName)) throw new OpensRefused("not a client name");
      if (!Number.isInteger(count) || count < 1 || count > MAX_RECORDED) throw new OpensRefused(`an open counts 1 to ${MAX_RECORDED}`);
      schema();
      const note = noteAt(path);
      if (note === null) return { recorded: false };
      const at = now();
      for (let i = 0; i < count; i += 1) {
        sql.exec("INSERT INTO ws_open_log (note, at, who, by, surface, client, client_name) VALUES (?, ?, ?, ?, ?, ?, ?)", note, at, who, by, surface, client, clientName);
      }
      return { recorded: true };
    },

    /**
     * For each path asked, `{ mine, people, ai }` from the log: `who`'s own opens, every person's, every AI client's
     * reads (Tex's included). A path never opened is left out.
     */
    of({ paths, who = null } = {}) {
      if (!Array.isArray(paths) || paths.length > MAX_ASKED || !paths.every(isPath)) throw new OpensRefused(`a search asks about 0 to ${MAX_ASKED} paths`);
      if (who !== null && !isWho(who)) throw new OpensRefused("not a person");
      schema();
      const opens = {};
      for (const path of new Set(paths)) {
        const note = noteAt(path);
        if (note === null) continue;
        let mine = 0;
        let people = 0;
        let ai = 0;
        for (const row of rows(sql.exec("SELECT who, by, count(*) AS count FROM ws_open_log WHERE note = ? GROUP BY who, by", note))) {
          const count = Number(row.count) || 0;
          if (row.by === "ai") ai += count;
          else {
            people += count;
            if (row.who === who) mine += count;
          }
        }
        if (mine + people + ai > 0) opens[path] = { mine, people, ai };
      }
      return { opens };
    },
  };
}
