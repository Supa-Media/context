/**
 * Whether a workspace is keyed: its notes' bytes live at their id keys, and the
 * path objects the bucket still holds are frozen copies nothing reads again
 * (`storageKey` on `lib/schema/nodes.ts`).
 *
 * Keyed is two facts together: the switch is at `keys` (`noteIdLayout.mode`)
 * AND the workspace's copy row has `keyedAt`, the flip having started. Either
 * alone is not keyed: a switch thrown before any flip has no keyed rows to
 * protect, and a flip whose switch was later moved back has no reason to hold.
 *
 * Every caller asks through here, so the question has one answer everywhere.
 */

import type { Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";

export async function keyedWorkspace(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<boolean> {
  const layout = await db.query("noteIdLayout").first();
  if (layout?.mode !== "keys") return false;
  const copies = await db
    .query("noteIdCopies")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return copies?.keyedAt !== undefined;
}
