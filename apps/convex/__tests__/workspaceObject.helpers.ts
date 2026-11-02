/**
 * A real workspace object (`serveWorkspaceStore` over `node:sqlite`) behind the real client (`workspaceClient`),
 * for the workspace-object tests.
 */

import { createRequire } from "node:module";
import { texObjects } from "../../mcp/src/texStore/objects.js";
import { workspaceRows } from "../../mcp/src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../../mcp/src/workspaceStore/serve.js";
import { workspaceClient } from "../../mcp/src/workspaceStore/api.js";
import type { BodyStore } from "../functions/lib/workspaceObjects/bodies";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...binds: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...(binds as never[]));
        return { toArray: () => all };
      }
      statement.run(...(binds as never[]));
      return { toArray: () => [] };
    },
  };
}

/** A real workspace object for `workspaceId`, and its client. */
export function objectFor(workspaceId = "ws1") {
  const sql = durableSql();
  const store = { rows: workspaceRows(sql), objects: texObjects(sql) };
  const stub = { fetch: (request: Request) => serveWorkspaceStore(store, request) };
  const client = workspaceClient({ WORKSPACE_STORE: { idFromName: (name: string) => name, get: () => stub } }, workspaceId)!;
  return { store, client, bodies: client.bodies as unknown as BodyStore };
}
