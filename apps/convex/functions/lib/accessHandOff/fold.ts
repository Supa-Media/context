/**
 * One person's two accounts folded into one (`lib/account/foldIn.ts`), once a
 * workspace it touches decides its members in its object. A fold moves the
 * closing account's memberships to the account it folds into, inside the
 * sign-in flow that proved both are the same person, and the flow goes on
 * using the result, so it cannot wait for a queue. It is the one change
 * written to Convex first: both sides of it are the same person, so the
 * object briefly still holding the old account, or not yet the new one, never
 * lets anyone in who was not already in. The queue then puts the new
 * account's row and removes the old one in each object
 * (`functions/accessTakeAway.ts`).
 *
 * Only the fold's own rows are let through the guard: a write to the members
 * of one of the fold's workspaces, for one of its two accounts, while the fold
 * is queued. Anything else in those workspaces is refused as always.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import { internal } from "../../../_generated/api";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { accessHomeOf } from "../accessObjects/home";
import { groupNames } from "../accessObjects/expected";
import { personalWorkspaceOf } from "../faces/people";
import type { AccessWrite } from "./record";
import type { TakeAwayStep } from "./takeAway";

/** Queue the objects' half of a fold, when any of its workspaces decides its members in its object. */
export async function queueFold(ctx: MutationCtx, fromId: Id<"users">, intoId: Id<"users">, workspaceIds: Id<"workspaces">[]): Promise<void> {
  const switched: Id<"workspaces">[] = [];
  for (const workspaceId of workspaceIds) if ((await accessHomeOf(ctx.db, workspaceId, "workspace")) !== "convex") switched.push(workspaceId);
  if (switched.length === 0) return;
  const id = await ctx.db.insert("accessTakeAways", { kind: "fold", userId: fromId, intoId, workspaceIds: switched, at: Date.now(), attempt: 0 });
  await ctx.scheduler.runAfter(0, internal.functions.accessTakeAway.run, { id });
}

/** Whether `write` is one of a queued fold's own membership rows. */
export async function foldCovers(ctx: QueryCtx, write: AccessWrite): Promise<boolean> {
  if (write.table !== "workspaceMembers") return false;
  const userId = write.doc.userId as Id<"users"> | undefined;
  const workspaceId = write.doc.workspaceId as Id<"workspaces"> | undefined;
  if (userId === undefined || workspaceId === undefined) return false;
  const jobs = [
    ...(await ctx.db.query("accessTakeAways").withIndex("by_user", (q) => q.eq("userId", userId)).collect()),
    ...(await ctx.db.query("accessTakeAways").withIndex("by_into", (q) => q.eq("intoId", userId)).collect()),
  ];
  return jobs.some((job) => job.kind === "fold" && (job.workspaceIds ?? []).includes(workspaceId));
}

/** Each fold workspace's step, from Convex as it stands now: the new account's row put, the old one removed. */
export async function foldSteps(ctx: QueryCtx, job: Doc<"accessTakeAways">): Promise<TakeAwayStep[]> {
  const fromId = job.userId!;
  const intoId = job.intoId!;
  const into = await personalWorkspaceOf(ctx, intoId);
  const steps: TakeAwayStep[] = [];
  for (const workspaceId of job.workspaceIds ?? []) {
    const home = await accessHomeOf(ctx.db, workspaceId, "workspace");
    const workspace = await ctx.db.get(workspaceId);
    if (home === "convex" || workspace === null) continue;
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", intoId))
      .unique();
    const put =
      membership !== null && into !== null
        ? {
            row: { userId: String(intoId), personalWorkspaceId: String(into._id), role: membership.role, groups: await groupNames(ctx, workspaceId, intoId), at: job.at },
            workspace: { slug: workspace.slug, kind: workspace.kind },
          }
        : undefined;
    steps.push({ scope: "workspace", workspaceId, home, userIds: [String(fromId)], inviteIds: [], ...(put ? { put } : {}) });
  }
  return steps;
}
