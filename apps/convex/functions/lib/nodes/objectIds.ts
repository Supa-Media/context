/**
 * Which `nodes` row a workspace object means by a row id (`docs/decisions/storage-and-credentials/object-row-writes.md`).
 *
 * The object knows a row Convex made by its `_id` and a row it made itself by the id it gave it (`o_` and 32 hex
 * characters), which Convex keeps as `nodes.objectId` when it takes the row behind the object. A mirrored change
 * names rows by the object's id, so every reader of one resolves it here, never by guessing which kind it is.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";

/** The object's id for a row it made: `o_` and 32 lowercase hex characters (`treeOps.js` `objectRowId`). */
export const OBJECT_ROW_ID = /^o_[0-9a-f]{32}$/;

/**
 * The row of `workspaceId` the object calls `id`, live or gone, or null. A row of another workspace is never
 * answered, whichever kind of id names it.
 */
export async function nodeByObjectId(db: DatabaseReader, workspaceId: Id<"workspaces">, id: string): Promise<Doc<"nodes"> | null> {
  if (OBJECT_ROW_ID.test(id)) {
    return await db
      .query("nodes")
      .withIndex("by_workspace_objectId", (q) => q.eq("workspaceId", workspaceId).eq("objectId", id))
      .first();
  }
  const nodeId = db.normalizeId("nodes", id);
  if (nodeId === null) return null;
  const doc = await db.get(nodeId);
  return doc !== null && doc.workspaceId === workspaceId ? doc : null;
}
