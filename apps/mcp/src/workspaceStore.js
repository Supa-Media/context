/**
 * The Durable Object that holds one workspace's notes, tree rows and access
 * rules (decided by the owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`). The shape is
 * `workspaceStore/api.js`; the calls are `workspaceStore/serve.js`.
 *
 * Reached only from this gateway, which has already checked who is asking and
 * passes the grant's scope and row tokens; the object decides what those may
 * see with the same `canSee` the gateway runs.
 */

import { texObjects } from "./texStore/objects.js";
import { workspaceRows } from "./workspaceStore/rows.js";
import { serveWorkspaceStore } from "./workspaceStore/serve.js";

export class WorkspaceStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.store = null;
  }

  ready() {
    if (this.store !== null) return this.store;
    const sql = this.state.storage.sql;
    this.store = { objects: texObjects(sql), rows: workspaceRows(sql) };
    return this.store;
  }

  async fetch(request) {
    return await serveWorkspaceStore(this.ready(), request);
  }
}
