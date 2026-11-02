/**
 * The Durable Object that holds one workspace's notes, tree rows and access
 * rules (decided by the owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`). The shape is
 * `workspaceStore/api.js`; the calls are `workspaceStore/serve.js`.
 *
 * Reached only from this gateway, which has already checked who is asking and
 * passes the grant's scope and row tokens; the object decides what those may
 * see with the same `canSee` the gateway runs.
 *
 * It also keeps the app's live file tree (`workspaceStore/treeSockets.js`): a
 * socket the gateway's `/tree` route opened, told again whenever a call here
 * changes a folder it watches.
 */

import { texObjects } from "./texStore/objects.js";
import { workspaceRows } from "./workspaceStore/rows.js";
import { personRows } from "./workspaceStore/personRows.js";
import { tokenIndexClient } from "./workspaceStore/tokenIndex.js";
import { serveWorkspaceStore } from "./workspaceStore/serve.js";
import { treeSockets } from "./workspaceStore/treeSockets.js";

const CALL = "x-tex-call";

function opOf(request) {
  try {
    return JSON.parse(decodeURIComponent(request.headers.get(CALL) ?? "null"))?.op ?? null;
  } catch {
    return null;
  }
}

export class WorkspaceStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.store = null;
    this.tree = null;
  }

  ready() {
    if (this.store !== null) return this.store;
    const sql = this.state.storage.sql;
    this.store = {
      objects: texObjects(sql),
      rows: workspaceRows(sql),
      // A personal workspace's object is also its person's: reach, shares to them and their connections.
      person: personRows(sql),
      sql,
      // Every connection it keeps is findable from an old refresh token (`workspaceStore/tokenIndex.js`).
      indexRefresh: async (hash, personalWorkspaceId) => await tokenIndexClient(this.env, hash)?.set(personalWorkspaceId),
      // One storage transaction for `ws.apply`: all of a change lands, or none of it.
      transact: (work) => this.state.storage.transactionSync(work),
    };
    const tree = treeSockets(this.state, sql, this.store);
    this.store.onTreeChange = (change) => tree.changed(change);
    this.tree = tree;
    return this.store;
  }

  async fetch(request) {
    const store = this.ready();
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") return this.tree.accept(request);
    const response = await serveWorkspaceStore(store, request);
    // Where the tree is read from changed: watchers of a workspace switched back are told to read Convex.
    if (opOf(request) === "ws.home" && response.ok) this.tree.notice({ all: true });
    return response;
  }

  async webSocketMessage(ws, raw) {
    this.ready();
    await this.tree.message(ws, raw);
  }

  async webSocketClose(ws) {
    this.ready();
    this.tree.closed(ws);
  }

  async webSocketError(ws) {
    this.ready();
    this.tree.closed(ws);
  }
}
