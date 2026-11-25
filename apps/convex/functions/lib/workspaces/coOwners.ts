/**
 * Co-owners: making one, stepping one down, and handing the workspace over
 * (decided by the owner, 2026-11-25; `docs/decisions/identity-and-access/co-owners.md`).
 *
 * A co-owner is a member with the `owner` role who is not the workspace's
 * owner (`primaryOwner.ts`). Only the owner makes or removes co-owners, and
 * only on a shared workspace: a personal one carries its person's mail,
 * calendar and Tex, so it keeps exactly one owner. A co-owner may step
 * themself down. Nobody changes the owner's role; the owner hands the
 * workspace to a co-owner instead, and stays on as a co-owner.
 *
 * Making a co-owner and handing over are big changes: each asks the actor's
 * email code (`lib/emailProof.ts`), so a phone alone cannot give a workspace
 * away. Nobody is emailed when a co-owner is made (the owner, 2026-11-25); the
 * audit trail records it.
 *
 * Where the workspace's members are decided in its object, a role change is
 * put there first and written to Convex behind it, through the same queue a
 * deletion uses (`functions/accessTakeAway.ts`, kind `role`): Convex never says
 * a role the object has not taken.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { requireEmailProof } from "../emailProof";
import { accessHomeOf } from "../accessObjects/home";
import { memberRow } from "../accessObjects/expected";
import { objectIdentity } from "./aliases";
import { getMembership } from "../workspaceAuth";
import type { TakeAwayStep } from "../accessHandOff/takeAway";
import { ownerMemberships, primaryOwnerOf, requirePrimaryOwner } from "./primaryOwner";

export type Role = "owner" | "editor" | "member";

const ownerOnly = () =>
  new ConvexError({ code: "OWNER_ONLY", message: "Only the workspace's owner can make or remove co-owners." });

/**
 * A role change that makes or unmakes an owner. The caller already checked the
 * actor holds the owner role. Returns `pending: true` when the object takes it
 * first and Convex follows.
 */
export async function changeOwnerRole(
  ctx: MutationCtx,
  args: { workspace: Doc<"workspaces">; actorId: Id<"users">; target: Doc<"workspaceMembers">; role: Role },
): Promise<{ role: Role; pending?: boolean }> {
  const { workspace, actorId, target, role } = args;
  const primary = await primaryOwnerOf(ctx, workspace);
  if (target.userId === primary) {
    throw new ConvexError({
      code: "CANNOT_CHANGE_OWNER_ROLE",
      message: "The workspace's owner keeps the owner role. Hand the workspace to a co-owner first.",
    });
  }
  const steppingDown = actorId === target.userId && target.role === "owner" && role !== "owner";
  if (!steppingDown && actorId !== primary) throw ownerOnly();
  if (role === "owner") {
    if (workspace.kind !== "shared") {
      throw new ConvexError({
        code: "PERSONAL_CONTEXT",
        message: "A personal workspace has one owner. Share it with editors instead.",
      });
    }
    await requireEmailProof(ctx, actorId);
  }
  return await applyRoleChange(ctx, { workspaceId: workspace._id, target, role, actorId });
}

/** Write the role now, or queue it object-first where the object decides the members. */
async function applyRoleChange(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; target: Doc<"workspaceMembers">; role: Role; actorId: Id<"users"> },
): Promise<{ role: Role; pending?: boolean }> {
  if ((await accessHomeOf(ctx.db, args.workspaceId, "workspace")) === "object") {
    const id = await ctx.db.insert("accessTakeAways", {
      kind: "role",
      workspaceId: args.workspaceId,
      userId: args.target.userId,
      role: args.role,
      actorId: args.actorId,
      at: Date.now(),
      attempt: 0,
    });
    await ctx.scheduler.runAfter(0, internal.functions.accessTakeAway.run, { id });
    return { role: args.role, pending: true };
  }
  await writeRole(ctx, args.target, args.role, args.actorId);
  return { role: args.role };
}

async function writeRole(ctx: MutationCtx, target: Doc<"workspaceMembers">, role: Role, actorId: Id<"users"> | undefined) {
  if (target.role === role) return;
  await ctx.db.patch(target._id, { role });
  await recordAudit(ctx, {
    workspaceId: target.workspaceId,
    actorUserId: actorId,
    action: "member.role_changed",
    details: { targetUserId: target.userId, previousRole: target.role, role, ownerRole: true },
  });
}

/** The object step of a queued role change: the member's row with its new role. None once they left. */
export async function roleSteps(ctx: QueryCtx, job: Doc<"accessTakeAways">): Promise<TakeAwayStep[]> {
  if (job.workspaceId === undefined || job.userId === undefined || job.role === undefined) return [];
  const workspace = await ctx.db.get(job.workspaceId);
  const member = await getMembership(ctx, job.workspaceId, job.userId);
  const home = await accessHomeOf(ctx.db, job.workspaceId, "workspace");
  if (workspace === null || member === null || home === "convex") return [];
  const row = await memberRow(ctx, { ...member, role: job.role }, job.at);
  if (row === null) return [];
  return [{ scope: "workspace", workspaceId: job.workspaceId, home, userIds: [], inviteIds: [], puts: { rows: [row], workspace: objectIdentity(workspace) } }];
}

/** Convex's row, written behind the object that took the role change. */
export async function finishRole(ctx: MutationCtx, job: Doc<"accessTakeAways">): Promise<void> {
  if (job.workspaceId === undefined || job.userId === undefined || job.role === undefined) return;
  const member = await getMembership(ctx, job.workspaceId, job.userId);
  if (member === null) return;
  await writeRole(ctx, member, job.role, job.actorId);
}

/** The owner hands the workspace to a co-owner, and stays on as a co-owner. */
export async function handOverHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; userId: Id<"users">; actorId: Id<"users"> },
): Promise<{ ownerUserId: Id<"users"> }> {
  const { workspace } = await requirePrimaryOwner(ctx, args.workspaceId, args.actorId);
  if (workspace.kind !== "shared") {
    throw new ConvexError({ code: "PERSONAL_CONTEXT", message: "A personal workspace stays with its person." });
  }
  if (args.userId === args.actorId) return { ownerUserId: args.actorId };
  const target = await getMembership(ctx, args.workspaceId, args.userId);
  if (target === null || target.role !== "owner") {
    throw new ConvexError({ code: "NOT_A_CO_OWNER", message: "Make them a co-owner first, then hand the workspace over." });
  }
  await requireEmailProof(ctx, args.actorId);
  await ctx.db.patch(args.workspaceId, { ownerUserId: args.userId });
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: args.actorId,
    action: "workspace.owner_changed",
    details: { previousOwnerUserId: args.actorId, ownerUserId: args.userId },
  });
  return { ownerUserId: args.userId };
}

/**
 * The owner's account is going and co-owners stay: the longest-serving
 * co-owner becomes the owner. Call before the leaving membership is deleted.
 */
export async function handToSuccessor(ctx: MutationCtx, workspaceId: Id<"workspaces">, leavingUserId: Id<"users">): Promise<void> {
  const workspace = await ctx.db.get(workspaceId);
  if (workspace === null || (await primaryOwnerOf(ctx, workspace)) !== leavingUserId) return;
  const successor = (await ownerMemberships(ctx, workspaceId))
    .filter((member) => member.userId !== leavingUserId)
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (successor === undefined) return;
  await ctx.db.patch(workspaceId, { ownerUserId: successor.userId });
  await recordAudit(ctx, {
    workspaceId,
    actorUserId: leavingUserId,
    action: "workspace.owner_changed",
    details: { previousOwnerUserId: leavingUserId, ownerUserId: successor.userId, reason: "account_deleted" },
  });
}
