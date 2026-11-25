/**
 * The handlers for `workspaces.listMembers`, `removeMember`, `leaveWorkspace`
 * and `setMemberRole`.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context and why a personal and a shared context are the same row,
 * and see each export's own doc comment there for its rules.
 */

import { ConvexError } from "convex/values";
import { requireAuthId } from "../signedIn";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { removeUserGrantsIn } from "../grants/removeUserGrants";
import { personalWorkspaceOf } from "../faces/people";
import { deleteMemberPlaces } from "../places";
import { getMembership, requireWorkspaceAccess, requireWorkspaceRole } from "../workspaceAuth";
import { MAX_MEMBERS_RETURNED } from "./constants";
import { memberNotFound } from "./errors";
import { changeOwnerRole, type Role } from "./coOwners";
import { primaryOwnerOf } from "./primaryOwner";

export async function listMembersHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<
  {
    userId: Id<"users">;
    role: string;
    /** The workspace's owner, as opposed to a co-owner (`primaryOwner.ts`). */
    isOwner: boolean;
    email?: string;
    name?: string;
    /** Their personal workspace's name, without the `@`: what people type to find them. */
    handle?: string;
    isMe: boolean;
    joinedAt: number;
  }[]
> {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceAccess(ctx, args.workspaceId, userId);

  const members = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .take(MAX_MEMBERS_RETURNED);

  const workspace = await ctx.db.get(args.workspaceId);
  const owner = workspace === null ? null : await primaryOwnerOf(ctx, workspace);
  const rows = [];
  for (const member of members) {
    const user = await ctx.db.get(member.userId);
    const handle = (await personalWorkspaceOf(ctx, member.userId))?.slug;
    rows.push({
      userId: member.userId,
      role: member.role,
      isOwner: member.userId === owner,
      email: user?.email,
      name: user?.name,
      ...(handle === undefined ? {} : { handle }),
      isMe: member.userId === userId,
      joinedAt: member.joinedAt,
    });
  }
  return rows.sort((a, b) => a.joinedAt - b.joinedAt);
}

export async function removeMemberHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; userId: Id<"users"> },
): Promise<{ removed: boolean }> {
  const actorId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");

  const target = await getMembership(ctx, args.workspaceId, args.userId);
  if (target === null) return { removed: false };

  if (target.role === "owner") {
    // The owner is never removed (they hand over first), and a co-owner is stepped down before removal, so a
    // removal never takes the owner role away by itself (`coOwners.ts`).
    const workspace = await ctx.db.get(args.workspaceId);
    const isOwner = workspace !== null && (await primaryOwnerOf(ctx, workspace)) === target.userId;
    throw new ConvexError({
      code: isOwner ? "CANNOT_REMOVE_OWNER" : "CO_OWNER",
      message: isOwner
        ? "The workspace's owner can't be removed. They can hand it to a co-owner first."
        : "Make them an editor or member first, then remove them.",
    });
  }

  await ctx.db.delete(target._id);
  // Their pins and open counts here: nobody else's business, and no longer theirs.
  await deleteMemberPlaces(ctx, args.workspaceId, args.userId);
  // Outside now: their account grants here go with them (`grants/removeUserGrants.ts`).
  await removeUserGrantsIn(ctx, { workspaceId: args.workspaceId, userId: args.userId, actorUserId: actorId });

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: actorId,
    action: "member.removed",
    details: { targetUserId: args.userId, previousRole: target.role },
  });

  return { removed: true };
}

export async function leaveWorkspaceHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{ left: boolean }> {
  const userId = (await requireAuthId(ctx)) as Id<"users">;

  const membership = await getMembership(ctx, args.workspaceId, userId);
  if (membership === null) return { left: false };

  if (membership.role === "owner") {
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null || (await primaryOwnerOf(ctx, workspace)) === userId) {
      throw new ConvexError({
        code: "OWNER_CANNOT_LEAVE",
        message: "You own this workspace. Hand it to a co-owner first, then you can leave.",
      });
    }
  }

  await ctx.db.delete(membership._id);
  await deleteMemberPlaces(ctx, args.workspaceId, userId);
  await removeUserGrantsIn(ctx, { workspaceId: args.workspaceId, userId, actorUserId: userId });

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    action: "member.left",
    details: { previousRole: membership.role },
  });

  return { left: true };
}

export async function setMemberRoleHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; userId: Id<"users">; role: Role },
): Promise<{ role: string; pending?: boolean }> {
  const actorId = (await requireAuthId(ctx)) as Id<"users">;
  const { workspace } = await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");

  const target = await getMembership(ctx, args.workspaceId, args.userId);
  if (target === null) throw memberNotFound();

  if (target.role === args.role) return { role: target.role };
  // Making, stepping down or removing a co-owner: the owner's step, or a co-owner's own (`coOwners.ts`).
  if (target.role === "owner" || args.role === "owner") return await changeOwnerRole(ctx, { workspace, actorId, target, role: args.role });

  await ctx.db.patch(target._id, { role: args.role });

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: actorId,
    action: "member.role_changed",
    details: {
      targetUserId: args.userId,
      previousRole: target.role,
      role: args.role,
    },
  });

  return { role: args.role };
}
