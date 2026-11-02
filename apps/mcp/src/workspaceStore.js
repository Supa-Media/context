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
 *
 * And the app's access screens (`workspaceStore/accessSockets.js`): members,
 * invitations, connected apps and "shared with me", on a socket the gateway's
 * `/presence/access` route opened.
 */

import { texObjects } from "./texStore/objects.js";
import { TexObjectRefused } from "./texStore/objects.js";
import { callTexStore } from "./texStore/wire.js";
import { workspaceStub } from "./workspaceStore/api.js";
import { workspaceMembers } from "./workspaceStore/members.js";
import { workspaceRows } from "./workspaceStore/rows.js";
import { serveWorkspaceStore } from "./workspaceStore/serve.js";
import { flushReach } from "./workspaceStore/serveMembers.js";
import { treeSockets } from "./workspaceStore/treeSockets.js";
import { accessSockets } from "./workspaceStore/accessSockets.js";
import { watchMembers } from "./workspaceStore/accessWatch.js";

const CALL = "x-tex-call";
/** How long a person-object write that failed waits before it is sent again. */
const REACH_RETRY_MS = 30_000;

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
    this.access = null;
  }

  ready() {
    if (this.store !== null) return this.store;
    const sql = this.state.storage.sql;
    this.store = {
      objects: texObjects(sql),
      rows: workspaceRows(sql),
      members: workspaceMembers(sql),
      // A person's own object (`workspace:<personalWorkspaceId>`), told of a member change (`serveMembers.js`).
      reach: (personalWorkspaceId) => {
        const stub = workspaceStub(this.env, personalWorkspaceId);
        if (stub === null) return null;
        return {
          call: async (op, body) => {
            try {
              return await (await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify(body)))).json();
            } catch (error) {
              // A 422 is a write the person object will never keep: sending it again would be refused again.
              if (error instanceof TexObjectRefused) error.refused = true;
              throw error;
            }
          },
        };
      },
      retryLater: async () => {
        if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + REACH_RETRY_MS);
      },
      // One storage transaction for `ws.apply`: all of a change lands, or none of it.
      transact: (work) => this.state.storage.transactionSync(work),
    };
    const tree = treeSockets(this.state, sql, this.store);
    this.store.onTreeChange = (change) => tree.changed(change);
    this.tree = tree;
    this.access = accessSockets(this.state, sql);
    watchMembers(this.store, this.access, this.env);
    return this.store;
  }

  async fetch(request) {
    const store = this.ready();
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      return new URL(request.url).pathname === "/access" ? this.access.accept(request) : this.tree.accept(request);
    }
    const response = await serveWorkspaceStore(store, request);
    // Where the tree is read from changed: watchers of a workspace switched back are told to read Convex.
    if (opOf(request) === "ws.home" && response.ok) this.tree.notice({ all: true });
    return response;
  }

  /** Person-object writes still owed by member changes, sent again. */
  async alarm() {
    await flushReach(this.ready());
  }

  async webSocketMessage(ws, raw) {
    this.ready();
    if (this.access.owns(ws)) return await this.access.message(ws, raw);
    await this.tree.message(ws, raw);
  }

  async webSocketClose(ws) {
    this.ready();
    if (this.access.owns(ws)) return this.access.closed(ws);
    this.tree.closed(ws);
  }

  async webSocketError(ws) {
    this.ready();
    if (this.access.owns(ws)) return this.access.closed(ws);
    this.tree.closed(ws);
  }
}
