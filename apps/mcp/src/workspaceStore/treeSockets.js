/**
 * The app's live file tree, kept by the workspace object (decided by the
 * owner, 2026-11-01; `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * The gateway's `/tree` route (`live/treeRoute.js`) has already checked who is
 * asking, and hands the object one header naming the reader: the grant's
 * clamped scope, its group names and when the socket must check again. The
 * client names only the folders it wants to watch. Each watched folder is
 * listed at **that socket's** clearance (`listing.js`), and listed again when a
 * write touches it; a listing is sent only when it differs from the last one
 * that socket was sent, so a change to a note a reader cannot see sends that
 * reader nothing at all.
 *
 * Sockets hibernate. Everything a socket needs after the object wakes (its
 * reader, its folders and what it was last sent) is in this object's SQLite,
 * keyed by an id on the socket's attachment.
 *
 * A workspace whose tree is not read from its object (`home` is not
 * `object`) answers `not_served` and closes, and the app keeps reading Convex:
 * switching a workspace back is the rollback.
 */

import {
  decodeClientFrame,
  listingFrame,
  notServedFrame,
  pongFrame,
  TREE_CLOSE_NOT_SERVED,
  TREE_CLOSE_REAUTH,
  TREE_SOCKET_MAX_MS,
  TREE_WATCH_MAX,
} from "../../../../packages/shared/src/treeFrames.cjs";
import { HOMES } from "./api.js";
import { ACCESS_HOMES } from "./access.js";
import { judgedReader } from "./members.js";
import { folderPathOf, listFolderFromRows } from "./listing.js";
import { treeRows } from "./treeRows.js";

export const TREE_READER_HEADER = "x-tree-reader";
const SCOPES = new Set(["private", "team"]);
const MAX_GROUPS = 500;
/** Writes are gathered this long before watchers are listed again, so a burst is one pass. */
const NOTICE_GATHER_MS = 25;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ws_tree_sockets (id TEXT PRIMARY KEY, reader TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ws_tree_watch (socket TEXT NOT NULL, folder TEXT NOT NULL, sent TEXT, PRIMARY KEY (socket, folder))`,
];

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * The reader the gateway named, or null. Never anything the client sent: the
 * route sets this header itself after dropping every header of the request.
 */
export function readerOf(raw) {
  let reader;
  try {
    reader = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  if (!reader || typeof reader !== "object" || !SCOPES.has(reader.scope)) return null;
  if (!Array.isArray(reader.groups) || reader.groups.length > MAX_GROUPS) return null;
  if (!reader.groups.every((group) => typeof group === "string" && group.length > 0 && group.length <= 128)) return null;
  if (!Number.isFinite(reader.deadline)) return null;
  if (reader.userId !== undefined && !(typeof reader.userId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(reader.userId))) return null;
  return { scope: reader.scope, groups: [...new Set(reader.groups)], deadline: reader.deadline, ...(reader.userId ? { userId: reader.userId } : {}) };
}

async function digest(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {{acceptWebSocket: Function, getWebSockets: Function}} state  the Durable Object's state
 * @param {{exec: Function}} sql
 * @param {{rows: {rules: () => object|null, home: () => string}, members?: object}} store
 * @param {{now?: () => number, pair?: () => [WebSocket, WebSocket], schedule?: (fn: () => void, ms: number) => unknown, upgraded?: (client: WebSocket) => Response}} [deps]
 *   `pair` and `upgraded` are the runtime's (`WebSocketPair`, a 101) unless a test passes its own.
 */
export function treeSockets(state, sql, store, deps = {}) {
  for (const statement of SCHEMA) sql.exec(statement);
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const pair = deps.pair ?? (() => {
    const made = new WebSocketPair();
    return [made[0], made[1]];
  });
  const upgraded = deps.upgraded ?? ((client) => new Response(null, { status: 101, webSocket: client }));
  const tree = treeRows(sql);
  let pending = null;

  const socketId = (ws) => {
    try {
      const held = ws.deserializeAttachment();
      return held && held.tree === true && typeof held.id === "string" ? held.id : null;
    } catch {
      return null;
    }
  };
  const readerFor = (id) => {
    const row = all(sql.exec("SELECT reader FROM ws_tree_sockets WHERE id = ?", id))[0];
    return row ? JSON.parse(row.reader) : null;
  };
  const forget = (id) => {
    sql.exec("DELETE FROM ws_tree_watch WHERE socket = ?", id);
    sql.exec("DELETE FROM ws_tree_sockets WHERE id = ?", id);
  };
  const close = (ws, code, reason) => {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  };
  const openSockets = () => state.getWebSockets("tree").filter((ws) => ws.readyState === undefined || ws.readyState === 1);

  /**
   * The reader's clearance: the gateway's, or, where this object decides access, the reader as a member here
   * (`members.js` `judgedReader`). `null` (not a member, or a socket that names nobody) and the socket is closed.
   */
  const clearanceOf = (reader) => {
    const members = store.members ?? null;
    if (members === null || members.home() !== ACCESS_HOMES.OBJECT) return { scope: reader.scope, names: new Set(reader.groups) };
    if (typeof reader.userId !== "string") return null;
    const judged = judgedReader(members, { userId: reader.userId, scope: reader.scope, groups: reader.groups });
    return judged === null ? null : { scope: judged.scope, names: judged.tokens };
  };

  /** One folder at this clearance. */
  const listingFor = (folder, clearance) => {
    const { rows: children, more } = tree.children(folder);
    return listFolderFromRows({
      folder,
      clearance,
      // The console reads as a member (`resolveFileAccess` asks for one), so the members' rules judge it.
      held: store.rows.rules("member"),
      children,
      more,
      own: tree.own(folder),
      roots: tree.jobRows(),
    });
  };

  /** List `folders` for one socket, sending each that differs from what it was last sent. */
  const sendListings = async (ws, id, reader, folders) => {
    if (folders.length === 0) return;
    const clearance = clearanceOf(reader);
    if (clearance === null) {
      // No longer a member here: nothing more is listed, and the client must ask the gateway again.
      forget(id);
      close(ws, TREE_CLOSE_REAUTH, "reauthorize");
      return;
    }
    for (const folder of folders) {
      const frame = listingFrame(folder, listingFor(folder, clearance));
      const sent = await digest(frame);
      const held = all(sql.exec("SELECT sent FROM ws_tree_watch WHERE socket = ? AND folder = ?", id, folder))[0];
      if (held === undefined || held.sent === sent) continue;
      sql.exec("UPDATE ws_tree_watch SET sent = ? WHERE socket = ? AND folder = ?", sent, id, folder);
      ws.send(frame);
    }
  };

  /** Close a socket whose grant needs checking again; the client reconnects through the gateway. */
  const expired = (ws, id, reader) => {
    if (reader !== null && reader.deadline > now()) return false;
    forget(id);
    close(ws, TREE_CLOSE_REAUTH, "reauthorize");
    return true;
  };

  const flush = async () => {
    const notice = pending;
    pending = null;
    if (notice === null) return;
    const served = store.rows.home() === HOMES.OBJECT;
    for (const ws of openSockets()) {
      const id = socketId(ws);
      if (id === null) continue;
      if (!served) {
        forget(id);
        ws.send(notServedFrame());
        close(ws, TREE_CLOSE_NOT_SERVED, "not served");
        continue;
      }
      const reader = readerFor(id);
      if (expired(ws, id, reader)) continue;
      const watched = all(sql.exec("SELECT folder FROM ws_tree_watch WHERE socket = ?", id)).map((row) => row.folder);
      const touched = notice.all ? watched : watched.filter((folder) => notice.folders.has(folder));
      await sendListings(ws, id, reader, touched);
    }
  };

  return {
    /** Open a socket for the reader the gateway named. */
    accept(request) {
      const reader = readerOf(request.headers.get(TREE_READER_HEADER));
      if (reader === null) return new Response(JSON.stringify({ error: "bad_reader" }), { status: 400 });
      const [client, server] = pair();
      state.acceptWebSocket(server, ["tree"]);
      if (store.rows.home() !== HOMES.OBJECT) {
        server.send(notServedFrame());
        close(server, TREE_CLOSE_NOT_SERVED, "not served");
        return upgraded(client);
      }
      // A socket that went without a close event left its rows: drop every one no open socket holds.
      const live = new Set(openSockets().map(socketId).filter((held) => held !== null));
      for (const { id: held } of all(sql.exec("SELECT id FROM ws_tree_sockets"))) if (!live.has(held)) forget(held);
      const id = crypto.randomUUID();
      const deadline = Math.min(reader.deadline, now() + TREE_SOCKET_MAX_MS);
      sql.exec("INSERT INTO ws_tree_sockets (id, reader) VALUES (?, ?)", id, JSON.stringify({ ...reader, deadline }));
      server.serializeAttachment({ tree: true, id });
      return upgraded(client);
    },

    async message(ws, raw) {
      const id = socketId(ws);
      if (id === null) return close(ws, 1008, "unknown socket");
      const reader = readerFor(id);
      if (expired(ws, id, reader)) return;
      const frame = decodeClientFrame(typeof raw === "string" ? raw : null);
      if (frame === null) return close(ws, 1008, "bad frame");
      if (frame.t === "ping") return ws.send(pongFrame());
      if (store.rows.home() !== HOMES.OBJECT) {
        forget(id);
        ws.send(notServedFrame());
        return close(ws, TREE_CLOSE_NOT_SERVED, "not served");
      }
      const folders = [...new Set(frame.folders.map(folderPathOf).filter((folder) => folder !== null))].slice(0, TREE_WATCH_MAX);
      const held = new Set(all(sql.exec("SELECT folder FROM ws_tree_watch WHERE socket = ?", id)).map((row) => row.folder));
      for (const folder of held) if (!folders.includes(folder)) sql.exec("DELETE FROM ws_tree_watch WHERE socket = ? AND folder = ?", id, folder);
      const added = folders.filter((folder) => !held.has(folder));
      for (const folder of added) sql.exec("INSERT INTO ws_tree_watch (socket, folder, sent) VALUES (?, ?, '')", id, folder);
      await sendListings(ws, id, reader, added);
    },

    closed(ws) {
      const id = socketId(ws);
      if (id !== null) forget(id);
    },

    /**
     * Rows or rules changed: `rows` are every `{path, kind}` a write touched (a
     * moved row's old and new), `all` when rules, a whole copy or the home changed.
     * Watchers are listed again after a short gather.
     */
    notice({ rows = [], all: everything = false } = {}) {
      if (pending === null) {
        pending = { folders: new Set(), all: false };
        schedule(() => {
          flush().catch(() => {});
        }, NOTICE_GATHER_MS);
      }
      if (everything) pending.all = true;
      for (const row of rows) {
        if (typeof row?.path !== "string") continue;
        // The folder holding it; a folder's own listing (its job); and for a folder the root, where jobs are judged.
        pending.folders.add(parentOf(row.path));
        if (row.kind !== "file") {
          pending.folders.add(row.path);
          pending.folders.add("");
        }
      }
    },

    /**
     * The object's `onTreeChange` (`serve.js`): `paths` a row write touched
     * before and after, `null` for a whole copy; `rules` when the rules changed.
     */
    changed({ paths, rules = false } = {}) {
      if (paths === null || paths === undefined || rules) return this.notice({ all: true });
      const rows = paths.filter((path) => typeof path === "string" && path !== "").map((path) => ({ path, kind: tree.kindAt(path) ?? "folder" }));
      return this.notice({ rows });
    },

    /** For tests: run a gathered notice now. */
    flush,
  };
}
