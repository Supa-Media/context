/**
 * Whether a workspace's notes live in its object (`workspaceObjectHomes.home === "object"`).
 *
 * There the object is the writer of record for the tree rows, and Convex's `nodes`, `nodeAccess` and
 * `nodeAccessState` are a mirror written behind (`docs/decisions/storage-and-credentials/object-row-writes.md`). A
 * background job that would rewrite those rows from the bucket's point of view (a parent check, a fact fill, an id
 * check) asks this first and leaves such a workspace alone
 * (`docs/decisions/storage-and-credentials/background-tree-writers.md`).
 */

import type { Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";

export async function notesInObject(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<boolean> {
  const home = await db
    .query("workspaceObjectHomes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return home?.home === "object";
}
