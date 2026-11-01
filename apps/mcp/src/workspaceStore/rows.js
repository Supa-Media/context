/**
 * A workspace object's tree rows, access rules and state, in its own SQLite
 * (`workspaceStore/api.js` has the shapes). Pure over a `sql` with the Durable
 * Object's shape (`exec(query, ...binds)` → cursor with `toArray()`), so the
 * Node tests run it on `node:sqlite` and the object runs it as it is.
 *
 * Each row carries the writer's clock (`at`): a write older than the row held
 * is ignored, and a removal leaves a tombstone at its clock so a late upsert
 * cannot bring the row back.
 */

import { HOMES, isHome, MAX_ROWS_PER_PUT } from "./api.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ws_rows (
    id TEXT PRIMARY KEY,
    note_id TEXT,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    storage_key TEXT,
    etag TEXT,
    size INTEGER,
    collaborates INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL,
    gone INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS ws_rows_note ON ws_rows (note_id)`,
  `CREATE INDEX IF NOT EXISTS ws_rows_path ON ws_rows (path)`,
  `CREATE TABLE IF NOT EXISTS ws_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/** Thrown for a row or rule write the object will not keep. */
export class WorkspaceRowRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceRowRefused";
  }
}

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
const text = (value, max = 4096) => typeof value === "string" && value !== "" && value.length <= max && !value.includes("\0");

function rowOut(row) {
  return {
    id: row.id,
    noteId: row.note_id ?? null,
    path: row.path,
    kind: row.kind,
    storageKey: row.storage_key ?? null,
    etag: row.etag ?? null,
    size: row.size === null || row.size === undefined ? null : Number(row.size),
    collaborates: Number(row.collaborates) === 1,
    at: Number(row.at),
  };
}

function checkRow(row) {
  if (!row || typeof row !== "object") throw new WorkspaceRowRefused("not a row");
  if (!text(row.id, 128)) throw new WorkspaceRowRefused("a row needs its id");
  if (!text(row.path)) throw new WorkspaceRowRefused("a row needs its path");
  if (row.kind !== "file" && row.kind !== "folder") throw new WorkspaceRowRefused("a row is a file or a folder");
  if (!Number.isFinite(row.at)) throw new WorkspaceRowRefused("a row needs its writer's clock");
  if (row.noteId !== undefined && row.noteId !== null && !text(row.noteId, 64)) throw new WorkspaceRowRefused("not a note id");
  if (row.storageKey !== undefined && row.storageKey !== null && !text(row.storageKey, 1024)) throw new WorkspaceRowRefused("not a storage key");
  return row;
}

/** The rules as the control plane renders them (`HeldRules`): folders, notes, and the version they are at. */
function checkRules(rules) {
  if (!rules || typeof rules !== "object") throw new WorkspaceRowRefused("not rules");
  if (!Array.isArray(rules.folders) || !Array.isArray(rules.notes)) throw new WorkspaceRowRefused("rules need folders and notes");
  if (!Number.isFinite(rules.accessVersion)) throw new WorkspaceRowRefused("rules need their access version");
  for (const folder of rules.folders) if (typeof folder?.prefix !== "string" || typeof folder?.visibility !== "string") throw new WorkspaceRowRefused("not a folder rule");
  for (const note of rules.notes) if (typeof note?.path !== "string" || typeof note?.visibility !== "string") throw new WorkspaceRowRefused("not a note rule");
  return rules;
}

export function workspaceRows(sql) {
  for (const statement of SCHEMA) sql.exec(statement);
  const meta = (name) => all(sql.exec("SELECT value FROM ws_meta WHERE name = ?", name))[0]?.value ?? null;
  const setMeta = (name, value) => sql.exec("INSERT INTO ws_meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, value);

  return {
    /** Upsert rows; a row older than the one held (or its tombstone) is skipped. */
    put(rows) {
      if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_PUT) throw new WorkspaceRowRefused("rows come as a list of at most " + MAX_ROWS_PER_PUT);
      let kept = 0;
      for (const row of rows.map(checkRow)) {
        const held = all(sql.exec("SELECT at FROM ws_rows WHERE id = ?", row.id))[0];
        if (held && Number(held.at) > row.at) continue;
        sql.exec(
          `INSERT INTO ws_rows (id, note_id, path, kind, storage_key, etag, size, collaborates, at, gone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET note_id = excluded.note_id, path = excluded.path, kind = excluded.kind, storage_key = excluded.storage_key,
             etag = excluded.etag, size = excluded.size, collaborates = excluded.collaborates, at = excluded.at, gone = 0`,
          row.id, row.noteId ?? null, row.path, row.kind, row.storageKey ?? null, row.etag ?? null,
          Number.isFinite(row.size) ? row.size : null, row.collaborates === true ? 1 : 0, row.at,
        );
        kept += 1;
      }
      return { kept };
    },
    /** Remove rows at the writer's clock, leaving a tombstone. */
    remove(ids, at) {
      if (!Array.isArray(ids) || ids.length > MAX_ROWS_PER_PUT || !Number.isFinite(at)) throw new WorkspaceRowRefused("removals come as ids and a clock");
      let removed = 0;
      for (const id of ids) {
        if (!text(id, 128)) continue;
        const held = all(sql.exec("SELECT at FROM ws_rows WHERE id = ?", id))[0];
        if (held && Number(held.at) > at) continue;
        if (held) sql.exec("UPDATE ws_rows SET gone = 1, at = ? WHERE id = ?", at, id);
        else sql.exec("INSERT INTO ws_rows (id, path, kind, at, gone) VALUES (?, '', 'file', ?, 1)", id, at);
        removed += 1;
      }
      return { removed };
    },
    get(ids) {
      if (!Array.isArray(ids)) return [];
      return ids.flatMap((id) => all(sql.exec("SELECT * FROM ws_rows WHERE id = ? AND gone = 0", id)).map(rowOut));
    },
    /** The live row for a note id, or null. */
    byNoteId(noteId) {
      const row = all(sql.exec("SELECT * FROM ws_rows WHERE note_id = ? AND gone = 0 AND kind = 'file' ORDER BY at DESC LIMIT 1", noteId))[0];
      return row ? rowOut(row) : null;
    },
    list({ after = null, limit = 1000 } = {}) {
      const size = Math.max(1, Math.min(1000, Number(limit) || 1000));
      const page = all(
        typeof after === "string"
          ? sql.exec("SELECT * FROM ws_rows WHERE gone = 0 AND id > ? ORDER BY id LIMIT ?", after, size + 1)
          : sql.exec("SELECT * FROM ws_rows WHERE gone = 0 ORDER BY id LIMIT ?", size + 1),
      ).map(rowOut);
      const more = page.length > size;
      const rows = more ? page.slice(0, size) : page;
      return { rows, ...(more ? { after: rows[rows.length - 1].id } : {}) };
    },
    count() {
      return Number(all(sql.exec("SELECT COUNT(*) AS n FROM ws_rows WHERE gone = 0"))[0]?.n ?? 0);
    },
    /** Keep the rules unless the ones held are at a later access version. */
    putRules(rules) {
      checkRules(rules);
      const held = this.rules();
      if (held !== null && held.accessVersion > rules.accessVersion) return { kept: false, accessVersion: held.accessVersion };
      setMeta("rules", JSON.stringify(rules));
      return { kept: true, accessVersion: rules.accessVersion };
    },
    rules() {
      const value = meta("rules");
      return value === null ? null : JSON.parse(value);
    },
    home() {
      const value = meta("home");
      return isHome(value) ? value : HOMES.BUCKET;
    },
    setHome(home) {
      if (!isHome(home)) throw new WorkspaceRowRefused("not a home");
      setMeta("home", home);
      return home;
    },
    backfilledAt() {
      const value = meta("backfilledAt");
      return value === null ? null : Number(value);
    },
    markBackfilled(at) {
      if (!Number.isFinite(at)) throw new WorkspaceRowRefused("backfilled needs a time");
      setMeta("backfilledAt", String(at));
      return at;
    },
  };
}
