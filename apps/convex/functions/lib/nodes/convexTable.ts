/**
 * The `NodeTable` of one workspace, over Convex's `nodes` table. The rules
 * that change it are in `observe.ts`; this file only knows how to read and
 * write rows through the three indexes.
 *
 * Tenancy: every read is an index range that starts at this workspace, and
 * every write addressed by id first loads the row and refuses one that
 * belongs to another workspace. An id is an opaque string a caller may have
 * been handed, so it is never trusted to name a row of this workspace.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { NodeTable, StoredNode } from "./table";

const PATCHABLE = ["parentId", "name", "etag", "size", "uploaded", "observedAt", "goneAt"] as const;

function toStored(doc: Doc<"nodes">): StoredNode {
  return {
    id: doc._id,
    path: doc.path,
    parentId: doc.parentId,
    name: doc.name,
    kind: doc.kind,
    etag: doc.etag,
    size: doc.size,
    uploaded: doc.uploaded,
    observedAt: doc.observedAt,
    goneAt: doc.goneAt,
  };
}

/**
 * The table for `workspaceId`. Pass a `QueryCtx` for reads only (`insert`,
 * `patch`, `remove` will then be unavailable at runtime, so callers that
 * write take a `MutationCtx`).
 */
export function convexNodeTable(ctx: MutationCtx, workspaceId: Id<"workspaces">): NodeTable;
export function convexNodeTable(ctx: QueryCtx, workspaceId: Id<"workspaces">): Pick<NodeTable, "byPath" | "underPrefix" | "observedBefore">;
export function convexNodeTable(
  ctx: MutationCtx | QueryCtx,
  workspaceId: Id<"workspaces">,
): NodeTable {
  const writable = "insert" in ctx.db;
  const ownRow = async (id: string): Promise<Id<"nodes">> => {
    const nodeId = id as Id<"nodes">;
    const doc = await ctx.db.get(nodeId);
    if (doc === null || doc.workspaceId !== workspaceId) throw new Error("node is not in this workspace");
    return nodeId;
  };
  const writer = ctx as MutationCtx;

  return {
    async byPath(path) {
      const doc = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
        .unique();
      return doc === null ? null : toStored(doc);
    },

    async insert(node) {
      if (!writable) throw new Error("insert on a read-only node table");
      const id = await writer.db.insert("nodes", {
        workspaceId,
        path: node.path,
        parentId: node.parentId as Id<"nodes"> | undefined,
        name: node.name,
        kind: node.kind,
        etag: node.etag,
        size: node.size,
        uploaded: node.uploaded,
        observedAt: node.observedAt,
        goneAt: node.goneAt,
      });
      return id;
    },

    async patch(id, fields) {
      if (!writable) throw new Error("patch on a read-only node table");
      const nodeId = await ownRow(id);
      // Only the keys the caller named: a key passed as `undefined` clears that
      // field, and a key left out keeps it (a tombstone must not wipe an etag).
      const patch: Record<string, unknown> = {};
      for (const key of PATCHABLE) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
          patch[key] = (fields as Record<string, unknown>)[key];
        }
      }
      await writer.db.patch(nodeId, patch as Partial<Doc<"nodes">>);
    },

    async remove(id) {
      if (!writable) throw new Error("remove on a read-only node table");
      await writer.db.delete(await ownRow(id));
    },

    async underPrefix(prefix, { after, limit }) {
      // Everything under `prefix` sorts from `prefix` on; resume strictly after
      // `after` when it is itself under the walk. Stops at the first key that
      // leaves the prefix, so a page never reads past its own range.
      const lower = after !== undefined && after >= prefix ? after : prefix;
      const strictly = after !== undefined && after >= prefix;
      const rows = ctx.db.query("nodes").withIndex("by_workspace_path", (q) => {
        const scoped = q.eq("workspaceId", workspaceId);
        return strictly ? scoped.gt("path", lower) : scoped.gte("path", lower);
      });
      const out: StoredNode[] = [];
      for await (const doc of rows) {
        if (!doc.path.startsWith(prefix)) break;
        out.push(toStored(doc));
        if (out.length >= limit) break;
      }
      return out;
    },

    async observedBefore(before, limit) {
      const docs = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_observed", (q) => q.eq("workspaceId", workspaceId).lt("observedAt", before))
        .take(limit);
      return docs.map(toStored);
    },
  };
}
