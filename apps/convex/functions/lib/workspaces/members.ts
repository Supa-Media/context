/**
 * The handlers for `workspaces.listMembers`, `removeMember`, `leaveWorkspace`
 * and `setMemberRole`.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context and why a personal and a shared context are the same row,
 * and see each export's own doc comment there for its rules.
 */

import { ConvexError } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { getMembership, requireWorkspaceAccess, requireWorkspaceRole } from "../workspaceAuth";
import { MAX_MEMBERS_RETURNED } from "./constants";
import { memberNotFound } from "./errors";

export async function listMembersHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<
  {
    userId: Id<"users">;
    role: string;
    email?: string;
    name?: string;
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

  const rows = [];
  for (const member of members) {
    const user = await ctx.db.get(member.userId);
    rows.push({
      userId: member.userId,
      role: member.role,
      email: user?.email,
      name: user?.name,
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
    throw new ConvexError({
      code: "CANNOT_REMOVE_OWNER",
      message:
        "A context's owner cannot be removed. Transferring ownership is a separate step, and is not built yet.",
    });
  }

  await ctx.db.delete(target._id);

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
    throw new ConvexError({
      code: "OWNER_CANNOT_LEAVE",
      message:
        "You own this context, so leaving would orphan it. Transferring ownership is a separate step, and is not built yet.",
    });
  }

  await ctx.db.delete(membership._id);

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
  args: { workspaceId: Id<"workspaces">; userId: Id<"users">; role: "editor" | "member" },
): Promise<{ role: string }> {
  const actorId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");

  const target = await getMembership(ctx, args.workspaceId, args.userId);
  if (target === null) throw memberNotFound();

  if (target.role === "owner") {
    throw new ConvexError({
      code: "CANNOT_CHANGE_OWNER_ROLE",
      message:
        "A context's owner keeps the owner role. Transferring ownership is a separate step, and is not built yet.",
    });
  }

  if (target.role === args.role) return { role: target.role };

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
