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
    sort TEXT,
    created INTEGER,
    at INTEGER NOT NULL,
    gone INTEGER NOT NULL DEFAULT 0,
    own_at INTEGER NOT NULL DEFAULT 0,
    own_fields TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ws_rows_note ON ws_rows (note_id)`,
  `CREATE INDEX IF NOT EXISTS ws_rows_path ON ws_rows (path)`,
  // A move's case-twin check (`moveWrites.js` `twinsByCase`) and the job lookup (`treeOps.js` `jobsNow`) read these
  // instead of every row: at 30,000 rows each scan cost several ms on every move (2026-11-03).
  `CREATE INDEX IF NOT EXISTS ws_rows_path_folded ON ws_rows (lower(path))`,
  `CREATE INDEX IF NOT EXISTS ws_rows_live_folders ON ws_rows (path) WHERE gone = 0 AND kind = 'folder'`,
  `CREATE TABLE IF NOT EXISTS ws_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ws_stage (epoch TEXT NOT NULL, id TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (epoch, id))`,
];

/** The readers the control plane renders rules for, kept apart. A Tex guest chat's rules are not kept here. */
export const AUDIENCES = new Set(["member", "guest"]);

/** Whether a workspace holds a data key: `keyed` once one is made, `none` where the control plane found none. */
export const ENCRYPTION_STATES = new Set(["none", "keyed"]);

/** The fields a row's digest covers, in order. */
const DIGEST_FIELDS = ["id", "noteId", "path", "kind", "storageKey", "etag", "size", "collaborates", "uploaded", "role", "order", "archiveOf"];

/**
 * A row's digest line: its digest fields, then its Sort setting only when it has one, so every row made before the
 * setting existed keeps the digest it had (`lib/workspaceObjects/rows.ts` builds the same line). `created` is not
 * digested: it is fixed when the row is made and only ever orders a listing.
 */
export function digestLine(row) {
  const fields = DIGEST_FIELDS.map((field) => row[field] ?? null);
  return JSON.stringify(typeof row.sort === "string" && row.sort !== "" ? [...fields, row.sort] : fields);
}

/** Each row field the object may originate, and the column that holds it. */
const COLUMN = {
  noteId: "note_id",
  path: "path",
  kind: "kind",
  storageKey: "storage_key",
  etag: "etag",
  size: "size",
  collaborates: "collaborates",
  uploaded: "uploaded",
  role: "role",
  order: "ord",
  archiveOf: "archive_of",
  sort: "sort",
  created: "created",
};

const UPSERT = `INSERT INTO ws_rows (id, note_id, path, kind, storage_key, etag, size, collaborates, uploaded, role, ord, archive_of, sort, created, at, own_at, own_fields, gone)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT(id) DO UPDATE SET note_id = excluded.note_id, path = excluded.path, kind = excluded.kind, storage_key = excluded.storage_key,
    etag = excluded.etag, size = excluded.size, collaborates = excluded.collaborates, uploaded = excluded.uploaded, role = excluded.role,
    ord = excluded.ord, archive_of = excluded.archive_of, sort = excluded.sort, created = COALESCE(excluded.created, ws_rows.created),
    at = excluded.at, own_at = excluded.own_at, own_fields = excluded.own_fields, gone = 0`;

/** A row field's value as its column stores it. Every value is a SQLite value, never undefined. */
function stored(field, value) {
  if (field === "collaborates") return value === true ? 1 : 0;
  if (field === "size" || field === "uploaded" || field === "order" || field === "created") return Number.isFinite(value) ? value : null;
  return value ?? null;
}

/** Every column of a checked row, keyed by column name. */
function storedValues(row) {
  return Object.fromEntries(Object.keys(COLUMN).map((field) => [COLUMN[field], stored(field, row[field])]));
}

/** The fields a row's object-originated changes own, as a list (`[]` for none). */
function ownFieldsOf(row) {
  const value = row.own_fields === null || row.own_fields === undefined ? [] : JSON.parse(row.own_fields);
  return Array.isArray(value) ? value : [];
}

/** The `objectAt` a pushed row carries: what Convex had seen of the object's clock (0 when it names none). */
const objectAtOf = (row) => (Number.isFinite(row.objectAt) ? row.objectAt : 0);

/**
 * The fields a push of `row` must not overwrite, as a set: those the object wrote after the copy the push was built
 * from (`held.own_at` above the push's `objectAt`). Null when the push takes the whole row.
 */
function ownedAgainst(held, row) {
  if (held === null || Number(held.own_at) <= objectAtOf(row)) return null;
  const owned = ownFieldsOf(held);
  // A push that already says what the object wrote (Convex took the object's change, as with a folder's children,
  // whose paths Convex builds from the moved folder) has nothing left to keep from: it takes the row whole.
  const values = storedValues(row);
  const agrees = owned.every((field) =>
    field === "gone" ? Number(held.gone) === 0 : !Object.hasOwn(COLUMN, field) || values[COLUMN[field]] === held[COLUMN[field]],
  );
  return agrees ? null : new Set(owned);
}

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
    sort: row.sort ?? null,
    created: row.created === null || row.created === undefined ? null : Number(row.created),
    at: Number(row.at),
  };
}

function checkRow(row) {
  if (!row || typeof row !== "object") throw new WorkspaceRowRefused("not a row");
  if (!text(row.id, 128)) throw new WorkspaceRowRefused("a row needs its id");
  if (!text(row.path)) throw new WorkspaceRowRefused("a row needs its path");
  if (row.kind !== "file" && row.kind !== "folder") throw new WorkspaceRowRefused("a row is a file or a folder");
  if (!Number.isFinite(row.at)) throw new WorkspaceRowRefused("a row needs its writer's clock");
  if (row.objectAt !== undefined && !Number.isFinite(row.objectAt)) throw new WorkspaceRowRefused("a row's objectAt is a number");
  checkTexts(row);
  return row;
}

/** The optional text fields of a row or a change: a note id, a storage key, a role, an archive id, or null. */
function checkTexts(row) {
  if (row.noteId !== undefined && row.noteId !== null && !text(row.noteId, 64)) throw new WorkspaceRowRefused("not a note id");
  if (row.storageKey !== undefined && row.storageKey !== null && !text(row.storageKey, 1024)) throw new WorkspaceRowRefused("not a storage key");
  for (const field of ["role", "archiveOf"]) if (row[field] !== undefined && row[field] !== null && !text(row[field], 1024)) throw new WorkspaceRowRefused(`not a ${field}`);
  if (row.sort !== undefined && row.sort !== null && !text(row.sort, 32)) throw new WorkspaceRowRefused("not a sort");
  if (row.created !== undefined && row.created !== null && !Number.isFinite(row.created)) throw new WorkspaceRowRefused("not a created");
}

/**
 * An object-originated change's fields, checked as `checkRow` checks a row's: only known fields, each with a value its
 * column takes. Returns the named fields as `[field, value]` pairs (an `undefined` value names nothing).
 */
function checkChange(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new WorkspaceRowRefused("a change names its fields");
  const given = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (given.length === 0) throw new WorkspaceRowRefused("a change names at least one field");
  for (const [field, value] of given) {
    if (!Object.hasOwn(COLUMN, field)) throw new WorkspaceRowRefused(`not a row field: ${field}`);
    if (field === "path" && !text(value)) throw new WorkspaceRowRefused("a row needs its path");
    if (field === "kind" && value !== "file" && value !== "folder") throw new WorkspaceRowRefused("a row is a file or a folder");
    if (field === "collaborates" && typeof value !== "boolean") throw new WorkspaceRowRefused("collaborates is true or false");
    if (["size", "uploaded", "order", "created"].includes(field) && value !== null && !Number.isFinite(value)) throw new WorkspaceRowRefused(`not a ${field}`);
    if (field === "etag" && value !== null && !text(value, 1024)) throw new WorkspaceRowRefused("not an etag");
  }
  checkTexts(fields);
  return given;
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

/**
 * Adds the ownership columns to a table made before them. `pragma_table_info` is read as a SELECT, so the same
 * `exec` shape serves the Durable Object and the Node tests, and the columns are added only where missing.
 */
function addOwnershipColumns(sql) {
  const have = new Set(all(sql.exec("SELECT name FROM pragma_table_info('ws_rows')")).map((column) => column.name));
  if (!have.has("own_at")) sql.exec("ALTER TABLE ws_rows ADD COLUMN own_at INTEGER NOT NULL DEFAULT 0");
  if (!have.has("own_fields")) sql.exec("ALTER TABLE ws_rows ADD COLUMN own_fields TEXT");
  // A folder's Sort setting and when a row was made (owner, 2026-11-04: `listingSort.cjs`).
  if (!have.has("sort")) sql.exec("ALTER TABLE ws_rows ADD COLUMN sort TEXT");
  if (!have.has("created")) sql.exec("ALTER TABLE ws_rows ADD COLUMN created INTEGER");
}

export function workspaceRows(sql) {
  for (const statement of SCHEMA) sql.exec(statement);
  addOwnershipColumns(sql);
  const meta = (name) => all(sql.exec("SELECT value FROM ws_meta WHERE name = ?", name))[0]?.value ?? null;
  const setMeta = (name, value) => sql.exec("INSERT INTO ws_meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, value);
  const heldRow = (id) => all(sql.exec("SELECT * FROM ws_rows WHERE id = ?", id))[0] ?? null;

  /**
   * Writes one row's columns. Its pushed values are written, except that the fields the object owns (`owned`, from
   * `ownedAgainst`) keep the held values; an owned row keeps its ownership, and a row taken whole clears it.
   */
  const upsertValues = (id, values, at, ownAt, ownFields) =>
    sql.exec(UPSERT, id, values.note_id, values.path, values.kind, values.storage_key, values.etag, values.size, values.collaborates,
      values.uploaded, values.role, values.ord, values.archive_of, values.sort, values.created, at, ownAt, ownFields);
  const writeRow = (row, held, owned) => {
    const values = storedValues(row);
    if (owned) for (const field of owned) if (Object.hasOwn(COLUMN, field)) values[COLUMN[field]] = held[COLUMN[field]];
    upsertValues(row.id, values, row.at, owned ? Number(held.own_at) : 0, owned ? held.own_fields : null);
  };

  return {
    /**
     * Upsert rows; a row older than the one held (or its tombstone) is skipped. A pushed row that names an `objectAt`
     * older than the object's own write to it keeps the fields the object wrote (see `originate`).
     */
    put(rows) {
      if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_PUT) throw new WorkspaceRowRefused("rows come as a list of at most " + MAX_ROWS_PER_PUT);
      let kept = 0;
      for (const row of rows.map(checkRow)) {
        const held = heldRow(row.id);
        if (held && Number(held.at) > row.at) continue;
        const owned = ownedAgainst(held, row);
        // A row the object removed (a trash emptied, a folder a move left empty) stays removed against an older push.
        if (owned?.has("gone") && Number(held.gone) === 1) continue;
        const path = owned?.has("path") ? held.path : row.path;
        // A folder that moved carries everything under it: the tree's move is one row (paths are built on read), so
        // the object rewrites its descendants' paths in the same call, or they would be judged under the old folder.
        if (held && Number(held.gone) === 0 && held.kind === "folder" && held.path !== "" && held.path !== path) {
          sql.exec(
            // Each moved row takes the folder's clock too, so a push of it read before the move is older and ignored.
            "UPDATE ws_rows SET path = ? || substr(path, length(?) + 1), at = MAX(at, ?) WHERE gone = 0 AND path >= ? || '/' AND path < ? || '0'",
            path, held.path, row.at, held.path, held.path,
          );
        }
        writeRow(row, held, owned);
        kept += 1;
      }
      return { kept };
    },
    /**
     * An object-originated change to a live row: only the named fields are written, stamped `max(now, held.at + 1)`,
     * and recorded as the object's own, so an older push from Convex keeps them (`put`). Null when the row is gone or
     * absent. A folder's path is not changed here: a move carries its descendants and has its own op.
     */
    originate(change, now) {
      if (!change || typeof change !== "object" || !text(change.id, 128)) throw new WorkspaceRowRefused("a change needs its id");
      if (!Number.isFinite(now)) throw new WorkspaceRowRefused("a change needs the object's clock");
      const given = checkChange(change.fields);
      const held = heldRow(change.id);
      if (held === null || Number(held.gone) !== 0) return null;
      const fields = Object.fromEntries(given);
      if (fields.path !== undefined && fields.path !== held.path && (fields.kind ?? held.kind) === "folder") {
        throw new WorkspaceRowRefused("move a folder with its own op");
      }
      const at = Math.max(now, Number(held.at) + 1);
      const values = Object.fromEntries(given.map(([field, value]) => [COLUMN[field], stored(field, value)]));
      const columns = Object.keys(values);
      const own = [...new Set([...ownFieldsOf(held), ...given.map(([field]) => field)])];
      sql.exec(
        `UPDATE ws_rows SET ${columns.map((column) => `${column} = ?`).join(", ")}, at = ?, own_at = ?, own_fields = ? WHERE id = ? AND gone = 0`,
        ...columns.map((column) => values[column]), at, at, JSON.stringify(own), change.id,
      );
      return rowOut(heldRow(change.id));
    },
    /**
     * A row the object creates at its clock `now`. It must not exist yet (a tombstone holds its id too), and every
     * field it names is the object's own.
     */
    originateNew(row, now) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new WorkspaceRowRefused("not a row");
      if (!Number.isFinite(now)) throw new WorkspaceRowRefused("a change needs the object's clock");
      const { id, at: _ignored, ...fields } = row;
      const given = checkChange(fields);
      const checked = checkRow({ ...fields, id, at: now });
      if (heldRow(id) !== null) throw new WorkspaceRowRefused("the row exists");
      // A row the object makes is made now, unless it says when (a copy of one made elsewhere).
      const values = storedValues(checked);
      if (values.created === null) values.created = now;
      upsertValues(id, values, now, now, JSON.stringify(given.map(([field]) => field)));
      return rowOut(heldRow(id));
    },
    /** The object's own clock and fields for a row (`ownFields` null when none), or null for no row. */
    ownership(id) {
      const row = heldRow(id);
      return row === null ? null : { ownAt: Number(row.own_at), ownFields: row.own_fields === null ? null : ownFieldsOf(row) };
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
    /** How many live file rows hold a note id. Above one, no single row is the note's (`serve.js` lookUp answers ambiguous). */
    liveNoteIdCount(noteId) {
      return Number(all(sql.exec("SELECT COUNT(*) AS n FROM ws_rows WHERE note_id = ? AND gone = 0 AND kind = 'file'", noteId))[0]?.n ?? 0);
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
      // The swap drops every row, so the held ownership is read first and each staged row merges against its own
      // (`writeRow`, as `put` does), with no skip and no folder rewrite: the copy is the whole truth, not a push.
      const held = new Map(all(sql.exec("SELECT * FROM ws_rows WHERE own_at > 0")).map((row) => [row.id, row]));
      sql.exec("DELETE FROM ws_rows");
      // A row the object holds as its own, written back exactly as it was held.
      const keep = (row) =>
        sql.exec(
          `INSERT INTO ws_rows (id, note_id, path, kind, storage_key, etag, size, collaborates, uploaded, role, ord, archive_of, sort, created, at, own_at, own_fields, gone)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.id, row.note_id, row.path, row.kind, row.storage_key, row.etag, row.size, row.collaborates, row.uploaded, row.role, row.ord,
          row.archive_of, row.sort ?? null, row.created ?? null, row.at, row.own_at, row.own_fields, row.gone,
        );
      const copied = new Set();
      for (const row of staged) {
        const before = held.get(row.id) ?? null;
        const owned = ownedAgainst(before, row);
        copied.add(row.id);
        // A row the object removed and Convex has not yet seen removed stays removed.
        if (owned?.has("gone") && Number(before.gone) === 1) keep(before);
        else writeRow(row, before, owned);
      }
      // A row the object made or changed that Convex has not confirmed yet (its ownership is still held) is not in a
      // copy read before the mirror took it: it stays. Once a push confirms it, its ownership clears and a later copy
      // that leaves it out drops it as usual.
      for (const [id, before] of held) if (!copied.has(id)) keep(before);
      sql.exec("DELETE FROM ws_stage");
      return { staged: page.length, swapped: true, rows: staged.length };
    },
    /** Live rows counted, and a SHA-256 over them in id order, so a copy can be compared without pulling every row. */
    async digest() {
      const live = all(sql.exec("SELECT * FROM ws_rows WHERE gone = 0 ORDER BY id")).map(rowOut);
      const canonical = live.map(digestLine).join("\n");
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
    /**
     * One page of live file rows in path order, after `after` and beneath `root` when it is named: the control
     * plane's tree reads walk these (`ws.rows.files`), as its own `nodes.listLive` pages its rows. The cursor is
     * the page's last path, `null` once the rows run out.
     */
    filesPage(/** @type {{after?: string | null, limit?: number, root?: string | null}} */ { after = null, limit = 1000, root = null } = {}) {
      const size = Math.max(1, Math.min(1000, Math.floor(Number(limit)) || 1000));
      const prefix = typeof root === "string" && root !== "" ? `${root}/` : "";
      const clauses = ["gone = 0", "kind = 'file'"];
      const args = [];
      if (prefix !== "") {
        // Every path under `a/b/` sorts before `a/b0`, the byte after "/".
        clauses.push("path >= ?", "path < ?");
        args.push(prefix, `${prefix.slice(0, -1)}0`);
      }
      if (typeof after === "string" && after !== "") {
        clauses.push("path > ?");
        args.push(after);
      }
      const rows = all(sql.exec(`SELECT * FROM ws_rows WHERE ${clauses.join(" AND ")} ORDER BY path LIMIT ?`, ...args, size)).map(rowOut);
      return { rows, cursor: rows.length >= size ? rows[rows.length - 1].path : null };
    },
    /**
     * Every live file row under `prefix` (`""`: the whole tree) whose path sorts after `after`, for a listing
     * (`manifest.js`). The range is on the path index; the caller judges and orders them.
     */
    filesUnder(prefix = "", after = null) {
      const from = typeof after === "string" && after > prefix ? after : prefix;
      const inclusive = from === prefix;
      // `prefix` ends in "/", so every path under it sorts before the same prefix ending in "0" (the byte after "/").
      const end = prefix === "" ? null : `${prefix.slice(0, -1)}0`;
      const query = `SELECT * FROM ws_rows WHERE gone = 0 AND kind = 'file' AND path ${inclusive ? ">=" : ">"} ?${end === null ? "" : " AND path < ?"}`;
      return all(end === null ? sql.exec(query, from) : sql.exec(query, from, end)).map(rowOut);
    },
    /** The live folders doing a job (`role`), oldest path first. */
    foldersByRole(role) {
      return all(sql.exec("SELECT * FROM ws_rows WHERE role = ? AND gone = 0 AND kind = 'folder' ORDER BY path", role)).map(rowOut);
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
    /**
     * Whether this workspace holds a data key (`ENCRYPTION_STATES`), or null where nobody has said. Only `none` lets a
     * reader go without asking the control plane for the key; `keyed` sticks, so a late `none` (a copy that read the
     * key rows before an owner turned encryption on) never undoes it.
     */
    encryption() {
      const value = meta("encryption");
      return ENCRYPTION_STATES.has(value) ? value : null;
    },
    setEncryption(state) {
      if (!ENCRYPTION_STATES.has(state)) throw new WorkspaceRowRefused("not an encryption state");
      if (state === "none" && meta("encryption") === "keyed") return "keyed";
      setMeta("encryption", state);
      return state;
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
