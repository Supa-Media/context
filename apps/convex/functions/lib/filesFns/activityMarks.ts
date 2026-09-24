/**
 * The activity stamps: when a context last changed, and when a member last
 * looked.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there.
 */

import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { requireWorkspaceAccess } from "../workspaceAuth";
import { callerId } from "./access";

export async function markWorkspaceActivityHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; at: number; teamVisible?: boolean },
): Promise<null> {
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null) return null;
  // Clamped to now as well as forward-only: a clock ahead of ours must not
  // park a context permanently in the future, where nothing is ever newer.
  const at = Math.min(args.at, Date.now());
  const patch: { activityAt?: number; activityTeamAt?: number } = {};
  if ((workspace.activityAt ?? 0) < at) patch.activityAt = at;
  if (args.teamVisible === true && (workspace.activityTeamAt ?? 0) < at) {
    patch.activityTeamAt = at;
  }
  if (patch.activityAt === undefined && patch.activityTeamAt === undefined) return null;
  await ctx.db.patch(args.workspaceId, patch);
  return null;
}

export async function activityLastSeenHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<number | null> {
  const actorUserId = await callerId(ctx);
  // Refused exactly as every other endpoint here refuses, rather than
  // answering `null` for a context the caller is not in: the isolation
  // census in `files.test.ts` compares the *whole* answer against the one a
  // workspace that never existed gives, and "null" from both would pass that
  // while still being a second shape of endpoint for anybody to reason about.
  await requireWorkspaceAccess(ctx, args.workspaceId, actorUserId);
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("userId", actorUserId),
    )
    .unique();
  return membership?.activitySeenAt ?? null;
}

export async function markActivitySeenHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; at?: number },
): Promise<null> {
  const actorUserId = await callerId(ctx);
  await requireWorkspaceAccess(ctx, args.workspaceId, actorUserId);
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("userId", actorUserId),
    )
    .unique();
  if (!membership) return null;
  const at = Math.min(args.at ?? Date.now(), Date.now());
  if ((membership.activitySeenAt ?? 0) >= at) return null;
  await ctx.db.patch(membership._id, { activitySeenAt: at });
  return null;
}
