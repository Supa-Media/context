import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";

/**
 * Whether deleting `userId` deletes this membership's workspace: they own it
 * and no other owner does. Editors and members remaining do not save it; an
 * ownerless context has nobody who can rebind storage or revoke a grant.
 *
 * One function for the deletion itself (`account.deleteAccount`) and for the
 * warning shown before it (`accountDeletion.deletionPreview`), so the list a
 * person is shown is the list that is deleted.
 */
export async function soleOwnerOf(
  ctx: QueryCtx,
  membership: Doc<"workspaceMembers">,
  userId: Id<"users">,
): Promise<boolean> {
  if (membership.role !== "owner") return false;
  const others = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", membership.workspaceId))
    .collect();
  return !others.some((other) => other.role === "owner" && other.userId !== userId);
}
