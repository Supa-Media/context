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
 */

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { requireWorkspaceRole } from "../workspaceAuth";

const OWNERS_EXAMINED = 200;

/** The workspace's owner's user id, or null when it has no member with the owner role. */
export async function primaryOwnerOf(ctx: QueryCtx, workspace: Doc<"workspaces">): Promise<Id<"users"> | null> {
  const owners = await ownerMemberships(ctx, workspace._id);
  for (const named of [workspace.ownerUserId, workspace.createdBy]) {
    if (named !== undefined && owners.some((member) => member.userId === named)) return named;
  }
  owners.sort((a, b) => a.joinedAt - b.joinedAt);
  return owners[0]?.userId ?? null;
}

/** Every member with the owner role: the owner and the co-owners. */
export async function ownerMemberships(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"workspaceMembers">[]> {
  const members = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(OWNERS_EXAMINED);
  return members.filter((member) => member.role === "owner");
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
