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

/**
 * Stamp a context as having changed, for the dot on its mark elsewhere.
 *
 * Monotonic, and that is the whole of its logic: two writers land lines in one
 * context — a person in the console and somebody's AI client through the
 * gateway — and neither knows about the other. A stamp that arrived late and
 * overwrote a newer one would put the dot out while something newer than the
 * reader's last visit was still unread.
 *
 * Internal: the gateway reaches it through `/gateway/activity`, and the
 * console through `runFileOperation`. Nothing a client can call.
 */
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

/**
 * When this person last looked at this context's activity.
 *
 * A query rather than part of the action below, because the unread line has to
 * move the moment somebody marks it read — and an action's result does not
 * re-run. The rows are fetched once; where the line sits among them is live.
 */
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

/**
 * Catch up: everything recorded before now is read.
 *
 * Only ever moves forward. Two devices open at once, or a stale tab pressing
 * this a minute late, must not walk the marker backwards and make a member
 * see yesterday's work as new again.
 */
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
