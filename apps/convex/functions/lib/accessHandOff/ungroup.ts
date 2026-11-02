/**
 * Taking people out of a group, once a workspace's members are decided in its
 * object (decided by the owner, 2026-11-01:
 * `docs/decisions/identity-and-access/access-in-objects.md`). A member's
 * groups are part of their row in the object, and a group can be what lets
 * them read a folder, so leaving one takes access away: the object must hear
 * it first. A mutation cannot call an object, so at `object` the change is
 * queued here and reported done; `functions/accessTakeAway.ts` puts each
 * leaving member's row without the group in the object, then deletes Convex's
 * group rows behind it (`finishUngroup`). Joining a group only lets someone
 * in, so it is written first like any join (`adds.ts`).
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { accessHomeOf } from "../accessObjects/home";
import { memberRow } from "../accessObjects/expected";
import type { TakeAwayStep } from "./takeAway";

export type Ungroup = {
  workspaceId: Id<"workspaces">;
  groupId: Id<"workspaceGroups">;
  userIds: Id<"users">[];
  /** The group itself goes too: every row naming it, its name, and the group. */
  wholeGroup?: boolean;
};

/**
 * Queue the change when the workspace's members are decided in its object, and answer `true`: the caller reports it
 * done and writes nothing. `false` means Convex still decides (or holds a copy), and the caller deletes as before.
 */
export async function ungroupFirst(ctx: MutationCtx, change: Ungroup): Promise<boolean> {
  if ((await accessHomeOf(ctx.db, change.workspaceId, "workspace")) !== "object") return false;
  const id = await ctx.db.insert("accessTakeAways", {
    kind: "ungroup",
    workspaceId: change.workspaceId,
    groupId: change.groupId,
    userIds: change.userIds,
    ...(change.wholeGroup === true ? { wholeGroup: true } : {}),
    at: Date.now(),
    attempt: 0,
  });
  await ctx.scheduler.runAfter(0, internal.functions.accessTakeAway.run, { id });
  return true;
}

/** The object's step: each leaving member's row as it will stand, without the group. Read from Convex now. */
export async function ungroupSteps(ctx: QueryCtx, job: Doc<"accessTakeAways">): Promise<TakeAwayStep[]> {
  const workspaceId = job.workspaceId!;
  const home = await accessHomeOf(ctx.db, workspaceId, "workspace");
  const workspace = await ctx.db.get(workspaceId);
  // Back on `convex` or `dual`, the deletion is written in Convex and the copy follows it.
  if (home !== "object" || workspace === null || job.groupId === undefined) return [];
  const rows: Record<string, unknown>[] = [];
  for (const userId of job.userIds ?? []) {
    const member = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
      .unique();
    const row = member === null ? null : await memberRow(ctx, member, job.at, job.groupId);
    if (row !== null) rows.push(row);
  }
  return [{ scope: "workspace", workspaceId, home, userIds: [], inviteIds: [], puts: { rows, workspace: { slug: workspace.slug, kind: workspace.kind } } }];
}

/**
 * Convex's group rows, deleted behind the object. A whole group that gained a member since it was queued is not
 * deleted yet: the job takes everyone now in it and runs again, so nobody keeps the group in the object.
 * Answers `false` when the job must run again.
 */
export async function finishUngroup(ctx: MutationCtx, job: Doc<"accessTakeAways">): Promise<boolean> {
  const groupId = job.groupId;
  if (groupId === undefined) return true;
  const planned = new Set((job.userIds ?? []).map(String));
  const rows = await ctx.db
    .query("workspaceGroupMembers")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .collect();
  if (job.wholeGroup === true && rows.some((row) => !planned.has(String(row.userId)))) {
    await ctx.db.patch(job._id, { userIds: [...new Set([...(job.userIds ?? []), ...rows.map((row) => row.userId)])], at: Date.now() });
    return false;
  }
  for (const row of rows) if (job.wholeGroup === true || planned.has(String(row.userId))) await ctx.db.delete(row._id);
  if (job.wholeGroup !== true) return true;
  const group = await ctx.db.get(groupId);
  if (group !== null) {
    const claim = await ctx.db
      .query("names")
      .withIndex("by_name", (q) => q.eq("name", group.name))
      .unique();
    if (claim !== null && claim.kind === "group") await ctx.db.delete(claim._id);
    await ctx.db.delete(groupId);
  }
  return true;
}

/**
 * `userIds` are (again) wanted in the group while a queued leave would take them out: they come off the queued
 * leave, so its finish keeps their rows, and their rows go to the object as they stand in Convex, which a put the
 * queue already made (stamped when it was queued) cannot roll back.
 */
export async function keepInGroup(ctx: MutationCtx, workspaceId: Id<"workspaces">, groupId: Id<"workspaceGroups">, userIds: Id<"users">[]): Promise<void> {
  if (userIds.length === 0) return;
  const wanted = new Set(userIds.map(String));
  const jobs = await ctx.db
    .query("accessTakeAways")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  const kept = new Set<string>();
  for (const job of jobs) {
    if (job.kind !== "ungroup" || job.groupId !== groupId || job.wholeGroup === true) continue;
    const staying = (job.userIds ?? []).filter((userId) => wanted.has(String(userId)));
    if (staying.length === 0) continue;
    for (const userId of staying) kept.add(String(userId));
    await ctx.db.patch(job._id, { userIds: (job.userIds ?? []).filter((userId) => !wanted.has(String(userId))) });
  }
  if (kept.size === 0) return;
  await ctx.db.insert("accessObjectOutbox", { workspaceId, tables: [], at: Date.now(), adds: { userIds: [...kept].sort(), inviteIds: [] } });
  await ctx.scheduler.runAfter(0, internal.functions.accessObjectPush.drain, { workspaceId });
}
