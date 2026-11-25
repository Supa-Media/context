/**
 * One owner per workspace, plus co-owners (decided by the owner, 2026-11-25;
 * `docs/decisions/identity-and-access/co-owners.md`).
 *
 * Every member whose role is `owner` sees and does what an owner does, so the
 * many `requireWorkspaceRole(..., "owner")` checks hold for co-owners
 * unchanged. A few steps nobody can take back belong to one person, the
 * workspace's owner: deleting the workspace, handing it over, making or
 * removing co-owners, disconnecting storage, managing the card, and connecting
 * or removing a custom domain. Those call `requirePrimaryOwner`.
 *
 * Who that is: `workspaces.ownerUserId` once ownership was handed over, else
 * the creator. Either must still hold the `owner` role; when neither does (a
 * row from before co-owners existed), the earliest-joined owner is the owner,
 * so a workspace with owners always has exactly one.
 *
 * Each of those is read from the person's own membership row, and the owners
 * from the owner side of `by_workspace_role`, never from a page of the
 * workspace's members: the owner of a workspace with more members than one
 * page used to resolve to whoever that page happened to hold, which after a
 * hand-over is the creator who handed it away.
 */

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { getMembership, requireWorkspaceRole } from "../workspaceAuth";

/** Owners examined for the fallback; a workspace with more than this many owners has no earliest-joined one. */
const OWNERS_EXAMINED = 200;

/** The workspace's owner's user id, or null when it has no member with the owner role. */
export async function primaryOwnerOf(ctx: QueryCtx, workspace: Doc<"workspaces">): Promise<Id<"users"> | null> {
  for (const named of [workspace.ownerUserId, workspace.createdBy]) {
    if (named === undefined) continue;
    const member = await getMembership(ctx, workspace._id, named);
    if (member?.role === "owner") return named;
  }
  const owners = await ownerMemberships(ctx, workspace._id);
  owners.sort((a, b) => a.joinedAt - b.joinedAt);
  return owners[0]?.userId ?? null;
}

/** Every member with the owner role: the owner and the co-owners. */
export async function ownerMemberships(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"workspaceMembers">[]> {
  return await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_role", (q) => q.eq("workspaceId", workspaceId).eq("role", "owner"))
    .take(OWNERS_EXAMINED);
}

/** Throws unless `userId` is the workspace's owner, not only a co-owner. */
export async function requirePrimaryOwner(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<{ workspace: Doc<"workspaces">; membership: Doc<"workspaceMembers"> }> {
  const access = await requireWorkspaceRole(ctx, workspaceId, userId, "owner");
  if ((await primaryOwnerOf(ctx, access.workspace)) !== userId) {
    throw new ConvexError({
      code: "OWNER_ONLY",
      message: "Only the workspace's owner can do this. Co-owners can do everything else.",
    });
  }
  return access;
}
