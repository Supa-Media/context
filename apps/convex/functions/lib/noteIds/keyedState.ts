/**
 * Whether a workspace is keyed: its notes' bytes live at their id keys, and the
 * path objects the bucket still holds are frozen copies nothing reads again
 * (`storageKey` on `lib/schema/nodes.ts`).
 *
 * Keyed is the workspace's copy row having `keyedAt`: born keyed at its first
 * binding (`born.ts`), or flipped by the copy pass. The paths/keys switch is
 * gone; every workspace is keyed (2026-10-22).
 *
 * Every caller asks through here, so the question has one answer everywhere.
 */

import type { Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";

export async function keyedWorkspace(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<boolean> {
  const copies = await db
    .query("noteIdCopies")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return copies?.keyedAt !== undefined;
}
