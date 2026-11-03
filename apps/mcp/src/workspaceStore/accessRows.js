/**
 * A workspace object's grant rows: who each note or folder is open to, held in the object beside its tree rows
 * (`workspaceStore/rows.js`), and the member and guest rules rendered from them here
 * (`docs/decisions/storage-and-credentials/object-row-writes.md`, "The object renders its own rules").
 *
 * Until the access writers move onto the object, the control plane still decides every access change and sends
 * the result with its push (`ws.apply` `access`): the whole set of rows that carry a setting, each as its base and
 * its grantees in the `nodeAccess` shape (`{kind, id, role}`), at the workspace's access version. The object keeps
 * the set, renders the rules from it exactly as `apps/convex/functions/lib/nodes/readerRules.ts` does (the same
 * `renderAccess`, `privacy/rowAccess.js`, and the same overlays: private pending paths, `accounts` only in the pinned
 * workspace, the pinned workspace's sealed chat homes), and records whether its rendering equals the rules the push
 * carried. Nothing serves the rendered rules yet: the pushed rules stay what every read is judged by, so a
 * difference here is a finding, never a wider read.
 *
 * Each record is keyed by its token id (the note id a grant's `@#<id>` names; a folder with none, its row id) and
 * kind. Its path is the object's own live row's when it holds one, so a move the object makes carries the rule with
 * it; the path the control plane sent is kept for a row the object no longer holds (a tombstone that still judges).
 *
 * Pure over a `sql` with the Durable Object's shape, like `rows.js`.
 */

import { renderAccess } from "../privacy/rowAccess.js";
import { WorkspaceRowRefused } from "./rows.js";

/**
 * The pinned workspace's chat homes folder (`@context/shared` `CHAT_HOMES_FOLDER`), written out so the object's own
 * code loads no TypeScript; `apps/convex/__tests__/nodes/objectAccessParity.test.ts` pins the two equal.
 */
export const CHAT_HOMES_FOLDER = "tex/groups";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ws_access (
    token TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    base TEXT,
    grantees TEXT NOT NULL,
    PRIMARY KEY (token, kind)
  )`,
];

/** How long a private path asked for before its row exists closes it (`lib/nodes/pendingAccess.ts` `PENDING_TTL_MS`). */
export const PENDING_TTL_MS = 60 * 60 * 1000;
/** The most access rows one set carries: far past any real workspace, under the object's 10 GB. */
export const MAX_ACCESS_ROWS = 100_000;
/** The most pending entries a set carries (`lib/nodes/pendingAccess.ts` `PENDING_MAX`). */
const MAX_PENDING = 100;

const GRANTEE_KINDS = new Set(["user", "group", "email", "members", "accounts"]);
const BASES = new Set(["private", "team"]);
const ROLES = new Set(["view", "edit"]);

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
const text = (value, max = 4096) => typeof value === "string" && value !== "" && value.length <= max && !value.includes("\0");
const fold = (path) => path.normalize("NFC").toLowerCase();

function checkGrantee(grantee) {
  if (!grantee || typeof grantee !== "object") throw new WorkspaceRowRefused("not a grantee");
  if (!GRANTEE_KINDS.has(grantee.kind)) throw new WorkspaceRowRefused("not a grantee kind");
  if (!text(grantee.id, 320)) throw new WorkspaceRowRefused("a grantee names who it is");
  if (!ROLES.has(grantee.role)) throw new WorkspaceRowRefused("a grant is to view or to edit");
  return { kind: grantee.kind, id: grantee.id, role: grantee.role };
}

function checkAccessRow(row) {
  if (!row || typeof row !== "object") throw new WorkspaceRowRefused("not an access row");
  if (!text(row.token, 128)) throw new WorkspaceRowRefused("an access row names its token");
  if (row.kind !== "file" && row.kind !== "folder") throw new WorkspaceRowRefused("an access row is a file or a folder");
  if (!text(row.path)) throw new WorkspaceRowRefused("an access row has its path");
  if (row.base !== undefined && row.base !== null && !BASES.has(row.base)) throw new WorkspaceRowRefused("a base is private or team");
  if (!Array.isArray(row.grantees) || row.grantees.length > 1000) throw new WorkspaceRowRefused("an access row carries its grantees");
  return { token: row.token, kind: row.kind, path: row.path, base: row.base ?? null, grantees: row.grantees.map(checkGrantee) };
}

function checkPending(entry) {
  if (!entry || typeof entry !== "object" || !text(entry.path)) throw new WorkspaceRowRefused("a pending entry has its path");
  if (entry.kind !== "file" && entry.kind !== "folder") throw new WorkspaceRowRefused("a pending entry is a file or a folder");
  if (!BASES.has(entry.base)) throw new WorkspaceRowRefused("a pending entry is private or team");
  if (!Number.isFinite(entry.at)) throw new WorkspaceRowRefused("a pending entry has its time");
  return { path: entry.path, kind: entry.kind, base: entry.base, at: entry.at };
}

/**
 * A whole access set as the control plane sends it: `{version, rows, pending, accounts, sealsChats, moving}`.
 * `accounts`: whether `accounts` grants are honoured here (the pinned workspace). `sealsChats`: whether the chat homes
 * are sealed here (`lib/nodes/sealedChats.ts`). `moving`: how many chunked moves the control plane is part way through,
 * while which its rules name both paths and no rendering of single paths can equal them.
 */
export function checkAccessSet(set) {
  if (!set || typeof set !== "object") throw new WorkspaceRowRefused("not an access set");
  if (!Number.isFinite(set.version)) throw new WorkspaceRowRefused("an access set has its version");
  if (!Array.isArray(set.rows) || set.rows.length > MAX_ACCESS_ROWS) throw new WorkspaceRowRefused("an access set carries its rows");
  const pending = set.pending ?? [];
  if (!Array.isArray(pending) || pending.length > MAX_PENDING) throw new WorkspaceRowRefused("not a list of pending entries");
  const rows = set.rows.map(checkAccessRow);
  const keys = new Set();
  for (const row of rows) {
    const key = `${row.kind}:${row.token}`;
    if (keys.has(key)) throw new WorkspaceRowRefused("two access rows for one token");
    keys.add(key);
  }
  return {
    version: set.version,
    rows,
    pending: pending.map(checkPending),
    accounts: set.accounts === true,
    sealsChats: set.sealsChats === true,
    moving: Number.isFinite(set.moving) && set.moving > 0 ? set.moving : 0,
  };
}

/**
 * The rows a reader judges by, from a set and the object's tree rows, as `accessRowsOf` builds them in the control
 * plane: each row at its live path (or the path sent), in path order, then the private pending paths no row holds,
 * then `accounts` grants dropped outside the pinned workspace, then the chat homes sealed where they are.
 */
export function judgedAccessRows(set, livePath, now) {
  const placed = set.rows.map((row) => ({
    path: livePath(row) ?? row.path,
    noteId: row.token,
    kind: row.kind,
    ...(row.base !== null ? { base: row.base } : {}),
    grantees: row.grantees.map((grantee) => ({ ...grantee })),
  }));
  placed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const held = new Set(placed.map((row) => row.path));
  for (const entry of set.pending) {
    if (entry.base !== "private" || entry.at < now - PENDING_TTL_MS || held.has(entry.path)) continue;
    placed.push({ path: entry.path, noteId: "", kind: entry.kind, base: "private", grantees: [] });
  }
  const honoured = set.accounts
    ? placed
    : placed
        .map((row) => ({ ...row, grantees: row.grantees.filter((grantee) => grantee.kind !== "accounts") }))
        .filter((row) => row.base !== undefined || row.grantees.length > 0);
  if (!set.sealsChats) return honoured;
  const root = fold(CHAT_HOMES_FOLDER);
  const out = [];
  for (const row of honoured) {
    if (fold(row.path) === root) continue;
    if (!fold(row.path).startsWith(`${root}/`)) {
      out.push(row);
      continue;
    }
    const grantees = row.grantees.filter((grantee) => grantee.kind === "user" || grantee.kind === "email");
    if (grantees.length > 0) out.push({ path: row.path, noteId: row.noteId, kind: row.kind, grantees });
  }
  out.push({ path: CHAT_HOMES_FOLDER, noteId: "sealed-chats", kind: "folder", grantees: [], sealed: true });
  return out;
}

/** The rules one audience is judged by, rendered from judged rows: `{folders, notes}`, each sorted by its key. */
export function renderedRules(judged, audience) {
  const { rules, overrides } = renderAccess(judged, audience);
  const folders = rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })).sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  const notes = [...overrides].map(([path, visibility]) => ({ path, visibility })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { folders, notes };
}

/**
 * How a rendering differs from the rules the control plane rendered: counts only (a path is never reported, as the
 * report that reads this is public). `equal` when both name the same rules with the same visibility.
 */
export function compareRules(rendered, held) {
  const side = (list, key) => new Map((list ?? []).map((entry) => [entry[key], entry.visibility]));
  const count = (ours, theirs) => {
    let missing = 0;
    let differs = 0;
    for (const [key, visibility] of theirs) {
      if (!ours.has(key)) missing += 1;
      else if (ours.get(key) !== visibility) differs += 1;
    }
    let extra = 0;
    for (const key of ours.keys()) if (!theirs.has(key)) extra += 1;
    return { missing, extra, differs };
  };
  const folders = count(side(rendered.folders, "prefix"), side(held.folders, "prefix"));
  const notes = count(side(rendered.notes, "path"), side(held.notes, "path"));
  const equal = [folders, notes].every((part) => part.missing === 0 && part.extra === 0 && part.differs === 0);
  return { equal, folders, notes };
}

export function workspaceAccess(sql) {
  for (const statement of SCHEMA) sql.exec(statement);
  const meta = (name) => all(sql.exec("SELECT value FROM ws_meta WHERE name = ?", name))[0]?.value ?? null;
  const setMeta = (name, value) => sql.exec("INSERT INTO ws_meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, value);
  /** The object's own live row for an access record, by its note id or (a folder with none) its row id. */
  const livePath = (row) =>
    all(
      sql.exec(
        "SELECT path FROM ws_rows WHERE gone = 0 AND kind = ? AND (note_id = ? OR (note_id IS NULL AND id = ?)) ORDER BY at DESC LIMIT 1",
        row.kind,
        row.token,
        row.token,
      ),
    )[0]?.path ?? null;
  /**
   * `livePath` for every held record at once: one statement instead of one per record. Rendering the rules asked once
   * per record, and a move renders them, so a workspace of 600 records spent about 15 ms of each move here
   * (2026-11-03). A record the held set does not have (a set being checked) is asked on its own.
   */
  const livePaths = () => {
    const found = new Map();
    for (const row of all(
      sql.exec(
        "SELECT a.token AS token, a.kind AS kind, (SELECT r.path FROM ws_rows r WHERE r.gone = 0 AND r.kind = a.kind AND (r.note_id = a.token OR (r.note_id IS NULL AND r.id = a.token)) ORDER BY r.at DESC LIMIT 1) AS live FROM ws_access a",
      ),
    )) {
      found.set(`${row.kind}\u0000${row.token}`, row.live ?? null);
    }
    return (row) => {
      const key = `${row.kind}\u0000${row.token}`;
      return found.has(key) ? found.get(key) : livePath(row);
    };
  };

  const held = () => {
    const header = meta("access:set");
    if (header === null) return null;
    const { version, pending, accounts, sealsChats, moving } = JSON.parse(header);
    const rows = all(sql.exec("SELECT * FROM ws_access ORDER BY kind, token")).map((row) => ({
      token: row.token,
      kind: row.kind,
      path: row.path,
      base: row.base ?? null,
      grantees: JSON.parse(row.grantees),
    }));
    return { version, rows, pending, accounts, sealsChats, moving };
  };

  return {
    /** The access set held, or null before the first. */
    set: held,
    version() {
      const header = meta("access:set");
      return header === null ? null : JSON.parse(header).version;
    },
    /** Replace the whole set unless the one held is at a later access version. Run inside the caller's transaction. */
    put(input) {
      const set = checkAccessSet(input);
      const version = this.version();
      if (version !== null && version > set.version) return { kept: false, version };
      // A version this object minted is never replaced by the control plane at the same version: its push of that
      // number was read before the object's write reached it (`object-row-writes.md`, "Access writes in the object").
      const minted = this.minted();
      if (minted !== null && set.version <= minted) return { kept: false, version };
      sql.exec("DELETE FROM ws_access");
      for (const row of set.rows) {
        sql.exec(
          "INSERT INTO ws_access (token, kind, path, base, grantees) VALUES (?, ?, ?, ?, ?)",
          row.token, row.kind, row.path, row.base, JSON.stringify(row.grantees),
        );
      }
      const { rows, ...header } = set;
      setMeta("access:set", JSON.stringify(header));
      return { kept: true, version: set.version };
    },
    /** The last access version this object minted itself (`accessWrite.js`), or null. */
    minted() {
      const value = meta("access:minted");
      return value === null ? null : Number(value);
    },
    /**
     * One record replaced in place, at a version the object minted: the write side of `ws.write.access`. A record left
     * with no base and no grantee carries no setting and is removed. Inside the caller's transaction.
     */
    writeRecord({ token, kind, path, base, grantees }, version) {
      const header = meta("access:set");
      if (header === null) throw new WorkspaceRowRefused("no access set is held yet");
      const record = checkAccessRow({ token, kind, path, base, grantees });
      sql.exec("DELETE FROM ws_access WHERE token = ? AND kind = ?", record.token, record.kind);
      if (record.base !== null || record.grantees.length > 0) {
        sql.exec(
          "INSERT INTO ws_access (token, kind, path, base, grantees) VALUES (?, ?, ?, ?, ?)",
          record.token, record.kind, record.path, record.base, JSON.stringify(record.grantees),
        );
      }
      setMeta("access:set", JSON.stringify({ ...JSON.parse(header), version }));
      setMeta("access:minted", String(version));
      return version;
    },
    /**
     * A base asked for a path with no row yet, kept as pending access at a version the object minted (the write side of
     * `ws.write.access` on a path with no row, as `lib/nodes/setAccess.ts` `setPendingAccess`). A base of `null`
     * (inherit) drops the entry. `PENDING_FULL` when a new entry would pass the cap. Inside the caller's transaction.
     */
    writePending({ path, kind, base }, version, now) {
      const header = meta("access:set");
      if (header === null) throw new WorkspaceRowRefused("no access set is held yet");
      const set = JSON.parse(header);
      const waiting = (set.pending ?? []).filter((entry) => entry.at >= now - PENDING_TTL_MS);
      const others = waiting.filter((entry) => entry.path !== path);
      if (base !== null && others.length === waiting.length && others.length >= MAX_PENDING) return { ok: false, code: "PENDING_FULL" };
      const pending = base === null ? others : [...others, checkPending({ path, kind, base, at: now })];
      setMeta("access:set", JSON.stringify({ ...set, pending, version }));
      setMeta("access:minted", String(version));
      return { ok: true, version };
    },
    /** The live pending entry at `path` for a row of `kind`, or null. */
    pendingAt(path, kind, now) {
      const set = held();
      return set?.pending.find((entry) => entry.path === path && entry.kind === kind && entry.at >= now - PENDING_TTL_MS) ?? null;
    },
    /**
     * A row born at `path`: the access waiting for it becomes the row's own record, and the entry goes, in the caller's
     * transaction (`lib/nodes/pendingAccess.ts` `applyPendingAccess`). The version does not move: the rules said this
     * already. Returns the base taken, or null when none was waiting.
     */
    takePending(path, kind, token, now) {
      const header = meta("access:set");
      if (header === null) return null;
      const set = JSON.parse(header);
      const entry = (set.pending ?? []).find((item) => item.path === path && item.kind === kind);
      if (entry === undefined) return null;
      setMeta("access:set", JSON.stringify({ ...set, pending: set.pending.filter((item) => item !== entry) }));
      if (entry.at < now - PENDING_TTL_MS) return null;
      const existing = all(sql.exec("SELECT base, grantees FROM ws_access WHERE token = ? AND kind = ?", token, kind))[0];
      if (existing !== undefined) {
        sql.exec("UPDATE ws_access SET base = ?, path = ? WHERE token = ? AND kind = ?", entry.base, path, token, kind);
      } else {
        sql.exec("INSERT INTO ws_access (token, kind, path, base, grantees) VALUES (?, ?, ?, ?, ?)", token, kind, path, entry.base, "[]");
      }
      return entry.base;
    },
    /** The rules one audience would be judged by, rendered here from `set` (the held one by default), or null with none. */
    render(audience, set = held(), now = Date.now()) {
      if (set === null) return null;
      return { ...renderedRules(judgedAccessRows(set, livePaths(), now), audience), accessVersion: set.version };
    },
    /**
     * Render from `set` and compare with the control plane's rules for each audience it sent (`{member?, guest?}`).
     * `skipped`: why no comparison means anything (a chunked move part way, or rules at another version).
     */
    check(set, rulesByAudience, now = Date.now()) {
      const checked = checkAccessSet(set);
      if (checked.moving > 0) return { version: checked.version, skipped: "moving" };
      const judged = judgedAccessRows(checked, livePaths(), now);
      const audiences = {};
      for (const [audience, rules] of Object.entries(rulesByAudience ?? {})) {
        if (!rules || rules.accessVersion !== checked.version) {
          audiences[audience] = { skipped: "version" };
          continue;
        }
        audiences[audience] = compareRules(renderedRules(judged, audience), rules);
      }
      return { version: checked.version, audiences };
    },
    /** Record a check's answer, for `ws.state` and the parity report. */
    recordParity(answer, at) {
      setMeta("access:parity", JSON.stringify({ ...answer, at }));
    },
    parity() {
      const value = meta("access:parity");
      return value === null ? null : JSON.parse(value);
    },
    count() {
      return Number(all(sql.exec("SELECT COUNT(*) AS n FROM ws_access"))[0]?.n ?? 0);
    },
  };
}
