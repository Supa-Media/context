/**
 * What changed in a workspace object since an index last caught up: the tree rows and note texts written since, kept
 * by SQLite triggers on the tables themselves, so every writer is covered (a Convex push, a row the object made, a
 * stage commit, a restore, a wipe) and none of them has to call anything.
 *
 * Each index keeps its own log under its own name (`ws_search` for words, `ws_meaning` for meaning), so one catching
 * up never takes a change from the other. A log is two tables: the ids of changed rows, and the keys of changed note
 * texts (`tex` 1 for the person's Tex tables), which `keysToRows` turns into the rows that name them.
 */

import { TEX_TABLES } from "../texStore/objects.js";

/** Where a person's Tex keys start (a storage key, not a folder: `["tex", "person"]`, as `texRouting.js` spells them). */
const PERSON_TEX = ["tex", "person"].join("/");
/** A person's own Tex note key (`store/texRouting.js`): its text is in this object's Tex tables, at the key's rest. */
export const PERSON_TEX_KEY = /^tex\/person:[A-Za-z0-9_-]{1,64}\/(notes\/[^/]+\.md)$/;
/** Changed note keys turned into changed rows in one call. */
const KEY_BATCH = 500;
const LOG_NAME = /^ws_[a-z]{1,20}$/;

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/**
 * The log named `name` over `sql`, its tables and triggers made on first use.
 *
 * @param {{exec: (query: string, ...binds: unknown[]) => {toArray(): object[]}}} sql
 * @param {string} name `ws_search`, `ws_meaning`
 */
export function changeLog(sql, name) {
  if (!LOG_NAME.test(name)) throw new TypeError("not a change log name");
  const rowsTable = `${name}_dirty_rows`;
  const keysTable = `${name}_dirty_keys`;
  /**
   * A trigger's insert into a change table. Never `INSERT OR IGNORE`: a trigger takes the conflict handling of the
   * statement that fired it, so under the rows' upsert an ignore would turn into an abort.
   */
  const dirtyRow = (row) => `INSERT INTO ${rowsTable} (id) SELECT ${row}.id WHERE NOT EXISTS (SELECT 1 FROM ${rowsTable} WHERE id = ${row}.id)`;
  const schema = [
    `CREATE TABLE IF NOT EXISTS ${rowsTable} (id TEXT PRIMARY KEY)`,
    `CREATE TABLE IF NOT EXISTS ${keysTable} (key TEXT NOT NULL, tex INTEGER NOT NULL, PRIMARY KEY (key, tex))`,
    `CREATE INDEX IF NOT EXISTS ws_search_rows_key ON ws_rows (storage_key)`,
    `CREATE TRIGGER IF NOT EXISTS ${name}_row_in AFTER INSERT ON ws_rows BEGIN ${dirtyRow("NEW")}; END`,
    `CREATE TRIGGER IF NOT EXISTS ${name}_row_up AFTER UPDATE ON ws_rows BEGIN ${dirtyRow("NEW")}; ${dirtyRow("OLD")}; END`,
    `CREATE TRIGGER IF NOT EXISTS ${name}_row_out AFTER DELETE ON ws_rows BEGIN ${dirtyRow("OLD")}; END`,
  ];
  /** Triggers that note a changed note text in `table` (`objects`, or the person's Tex objects: `tex` 1). */
  const textTriggers = (table, tex) => {
    const note = (row) => `INSERT INTO ${keysTable} (key, tex) SELECT ${row}.key, ${tex} WHERE ${row}.key >= 'notes/' AND ${row}.key < 'notes0'
      AND NOT EXISTS (SELECT 1 FROM ${keysTable} WHERE key = ${row}.key AND tex = ${tex})`;
    return [
      `CREATE TRIGGER IF NOT EXISTS ${name}_${table}_in AFTER INSERT ON ${table} BEGIN ${note("NEW")}; END`,
      `CREATE TRIGGER IF NOT EXISTS ${name}_${table}_up AFTER UPDATE ON ${table} BEGIN ${note("NEW")}; ${note("OLD")}; END`,
      `CREATE TRIGGER IF NOT EXISTS ${name}_${table}_out AFTER DELETE ON ${table} BEGIN ${note("OLD")}; END`,
    ];
  };
  const exists = (table) => all(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table)).length > 0;
  const count = (table) => Number(all(sql.exec(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n ?? 0);

  let ready = false;
  let texReady = false;

  return {
    /** Make the tables and triggers; the Tex tables' once they exist (`texHost.js` makes them on first use). */
    ensure() {
      if (!ready) {
        for (const statement of [...schema, ...textTriggers("objects", 0)]) sql.exec(statement);
        ready = true;
      }
      if (!texReady && exists(TEX_TABLES.objects)) {
        for (const statement of textTriggers(TEX_TABLES.objects, 1)) sql.exec(statement);
        texReady = true;
      }
    },

    /** Whether the person's Tex tables are here and watched. */
    get texReady() {
      return texReady;
    },

    /** Look at every note row again, and at `heldIds` (the rows an index holds entries for). */
    markAll(heldSelect = null) {
      sql.exec(`INSERT OR IGNORE INTO ${rowsTable} (id) SELECT id FROM ws_rows WHERE kind = 'file' AND gone = 0`);
      if (heldSelect) sql.exec(`INSERT OR IGNORE INTO ${rowsTable} (id) ${heldSelect}`);
    },

    /** Forget every changed key (an index emptied and looking at every row again needs none). */
    clearKeys() {
      sql.exec(`DELETE FROM ${keysTable}`);
    },

    /** Changed note texts, as the rows that name them: at most `KEY_BATCH` keys a call. */
    keysToRows() {
      const keys = all(sql.exec(`SELECT key, tex FROM ${keysTable} LIMIT ?`, KEY_BATCH));
      let texRows = null;
      for (const { key, tex } of keys) {
        if (Number(tex) === 1) {
          texRows ??= all(sql.exec("SELECT id, storage_key FROM ws_rows WHERE storage_key >= ? AND storage_key < ?", `${PERSON_TEX}:`, `${PERSON_TEX};`));
          for (const held of texRows) if (PERSON_TEX_KEY.exec(held.storage_key)?.[1] === key) sql.exec(`INSERT OR IGNORE INTO ${rowsTable} (id) VALUES (?)`, held.id);
        } else {
          const noteId = /^notes\/([^/]+)\.md$/.exec(key)?.[1] ?? null;
          // Two lookups, each by its own index: an `OR` of the two can scan every row.
          sql.exec(`INSERT OR IGNORE INTO ${rowsTable} (id) SELECT id FROM ws_rows WHERE storage_key = ?`, key);
          if (noteId !== null) sql.exec(`INSERT OR IGNORE INTO ${rowsTable} (id) SELECT id FROM ws_rows WHERE note_id = ?`, noteId);
        }
        sql.exec(`DELETE FROM ${keysTable} WHERE key = ? AND tex = ?`, key, tex);
      }
    },

    /** Up to `limit` changed row ids. */
    take(limit) {
      return all(sql.exec(`SELECT id FROM ${rowsTable} LIMIT ?`, limit)).map((row) => row.id);
    },

    /** A changed row looked at: off the log (a change after this puts it back). */
    done(id) {
      sql.exec(`DELETE FROM ${rowsTable} WHERE id = ?`, id);
    },

    /** A row taken off the log whose change did not land: back on it. */
    again(id) {
      sql.exec(`INSERT OR IGNORE INTO ${rowsTable} (id) VALUES (?)`, id);
    },

    /** Changes still waiting, rows and keys. */
    pending() {
      return count(rowsTable) + count(keysTable);
    },
  };
}
