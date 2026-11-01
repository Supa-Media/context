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
    uploaded INTEGER,
    role TEXT,
    ord REAL,
    archive_of TEXT,
    at INTEGER NOT NULL,
    gone INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS ws_rows_note ON ws_rows (note_id)`,
  `CREATE INDEX IF NOT EXISTS ws_rows_path ON ws_rows (path)`,
  `CREATE TABLE IF NOT EXISTS ws_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ws_stage (epoch TEXT NOT NULL, id TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (epoch, id))`,
];

/** The readers the control plane renders rules for, kept apart. A Tex guest chat's rules are not kept here. */
export const AUDIENCES = new Set(["member", "guest"]);

/** The fields a row's digest covers, in order. */
const DIGEST_FIELDS = ["id", "noteId", "path", "kind", "storageKey", "etag", "size", "collaborates", "uploaded", "role", "order", "archiveOf"];

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
    uploaded: row.uploaded === null || row.uploaded === undefined ? null : Number(row.uploaded),
    role: row.role ?? null,
    order: row.ord === null || row.ord === undefined ? null : Number(row.ord),
    archiveOf: row.archive_of ?? null,
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
  for (const field of ["role", "archiveOf"]) if (row[field] !== undefined && row[field] !== null && !text(row[field], 1024)) throw new WorkspaceRowRefused(`not a ${field}`);
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
        const held = all(sql.exec("SELECT at, path, kind, gone FROM ws_rows WHERE id = ?", row.id))[0];
        if (held && Number(held.at) > row.at) continue;
        // A folder that moved carries everything under it: the tree's move is one row (paths are built on read), so
        // the object rewrites its descendants' paths in the same call, or they would be judged under the old folder.
        if (held && Number(held.gone) === 0 && held.kind === "folder" && held.path !== "" && held.path !== row.path) {
          sql.exec(
            // Each moved row takes the folder's clock too, so a push of it read before the move is older and ignored.
            "UPDATE ws_rows SET path = ? || substr(path, length(?) + 1), at = MAX(at, ?) WHERE gone = 0 AND substr(path, 1, length(?) + 1) = ? || '/'",
            row.path, held.path, row.at, held.path, held.path,
          );
        }
        sql.exec(
          `INSERT INTO ws_rows (id, note_id, path, kind, storage_key, etag, size, collaborates, uploaded, role, ord, archive_of, at, gone)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET note_id = excluded.note_id, path = excluded.path, kind = excluded.kind, storage_key = excluded.storage_key,
             etag = excluded.etag, size = excluded.size, collaborates = excluded.collaborates, uploaded = excluded.uploaded, role = excluded.role,
             ord = excluded.ord, archive_of = excluded.archive_of, at = excluded.at, gone = 0`,
          row.id, row.noteId ?? null, row.path, row.kind, row.storageKey ?? null, row.etag ?? null,
          Number.isFinite(row.size) ? row.size : null, row.collaborates === true ? 1 : 0,
          Number.isFinite(row.uploaded) ? row.uploaded : null, row.role ?? null, Number.isFinite(row.order) ? row.order : null, row.archiveOf ?? null, row.at,
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
    /**
     * One page of a whole copy of the rows. `replace`: pages are staged under
     * `epoch`, and the last page swaps the staged set in as the rows, dropping
     * any row the copy does not name. `merge`: each page is an ordinary `put`.
     */
    snapshot({ epoch, last = false, rows: page, mode = "replace" } = {}) {
      if (mode === "merge") return { ...this.put(page), swapped: false };
      if (mode !== "replace" || !text(epoch, 64)) throw new WorkspaceRowRefused("a snapshot needs its epoch and a mode");
      if (!Array.isArray(page) || page.length > MAX_ROWS_PER_PUT) throw new WorkspaceRowRefused("rows come as a list of at most " + MAX_ROWS_PER_PUT);
      for (const row of page.map(checkRow)) {
        sql.exec("INSERT INTO ws_stage (epoch, id, row) VALUES (?, ?, ?) ON CONFLICT(epoch, id) DO UPDATE SET row = excluded.row", epoch, row.id, JSON.stringify(row));
      }
      if (last !== true) return { staged: page.length, swapped: false };
      const staged = all(sql.exec("SELECT row FROM ws_stage WHERE epoch = ?", epoch)).map((entry) => JSON.parse(entry.row));
      sql.exec("DELETE FROM ws_rows");
      for (let at = 0; at < staged.length; at += MAX_ROWS_PER_PUT) this.put(staged.slice(at, at + MAX_ROWS_PER_PUT));
      sql.exec("DELETE FROM ws_stage");
      return { staged: page.length, swapped: true, rows: staged.length };
    },
    /** Live rows counted, and a SHA-256 over them in id order, so a copy can be compared without pulling every row. */
    async digest() {
      const live = all(sql.exec("SELECT * FROM ws_rows WHERE gone = 0 ORDER BY id")).map(rowOut);
      const canonical = live.map((row) => JSON.stringify(DIGEST_FIELDS.map((field) => row[field] ?? null))).join("\n");
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
      return { rows: live.length, sha256: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") };
    },
    /** The workspace this object belongs to: pinned on the first call that names one, refused on any other. */
    pinWorkspace(workspaceId) {
      if (!text(workspaceId, 64)) throw new WorkspaceRowRefused("a call names its workspace");
      const held = meta("workspaceId");
      if (held === null) setMeta("workspaceId", workspaceId);
      else if (held !== workspaceId) throw new WorkspaceRowRefused("this object belongs to another workspace");
      return workspaceId;
    },
    count() {
      return Number(all(sql.exec("SELECT COUNT(*) AS n FROM ws_rows WHERE gone = 0"))[0]?.n ?? 0);
    },
    /**
     * Keep one audience's rules unless the ones held are at a later access version. The control plane renders
     * rules per reader (`member`, `guest`): a guest never sees a `team` row, so each is kept and judged apart.
     */
    putRules(rules, audience = "member") {
      checkRules(rules);
      if (!AUDIENCES.has(audience)) throw new WorkspaceRowRefused("not an audience");
      const held = this.rules(audience);
      if (held !== null && held.accessVersion > rules.accessVersion) return { kept: false, accessVersion: held.accessVersion };
      setMeta(`rules:${audience}`, JSON.stringify(rules));
      return { kept: true, accessVersion: rules.accessVersion };
    },
    rules(audience = "member") {
      if (!AUDIENCES.has(audience)) return null;
      const value = meta(`rules:${audience}`);
      return value === null ? null : JSON.parse(value);
    },
    /** The live row at a path, or null. */
    byPath(path) {
      const row = all(sql.exec("SELECT * FROM ws_rows WHERE path = ? AND gone = 0 ORDER BY at DESC LIMIT 1", path))[0];
      return row ? rowOut(row) : null;
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
