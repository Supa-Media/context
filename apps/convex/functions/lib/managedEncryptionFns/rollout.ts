/**
 * The staff rollout of managed-storage encryption: its states, and the
 * scheduler that moves workspaces through the walk.
 *
 * Rollout states:
 *  - `running`: waiting workspaces are started, a few at a time.
 *  - `paused` (staff) and `failed` (a walk stopped on a problem): every walk
 *    stops at its next page boundary and nothing new starts. Nothing is
 *    unreadable in either: a half-walked workspace reads both kinds.
 *  - `off` ("Stop starting new workspaces"): nothing new starts and waiting
 *    rows are dropped, but a walk already under way finishes, and encrypted
 *    workspaces stay encrypted. Turning it off never makes anything plain.
 *  - `complete`: nothing left to walk.
 *
 * Every public function here calls `requireAdmin` first.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { requireAdmin, userIsStaff } from "../admin";
import { bindingIsManaged, workspaceEncryptionRow } from "./state";

/** Workspaces walked at once. Small on purpose: this is our own R2 account. */
export const WALK_CONCURRENCY = 2;

export type RolloutScope = Doc<"managedEncryptionRollout">["scope"];
type Rollout = Doc<"managedEncryptionRollout">;

export async function rolloutRow(ctx: QueryCtx): Promise<Rollout | null> {
  return await ctx.db.query("managedEncryptionRollout").first();
}

type ManagedWorkspace = { workspaceId: Id<"workspaces">; slug: string; ours: boolean };

/** Every workspace whose binding is its managed bucket, with whether it is staff-owned. */
async function managedWorkspaces(ctx: QueryCtx): Promise<ManagedWorkspace[]> {
  const out: ManagedWorkspace[] = [];
  for await (const binding of ctx.db.query("storageBindings")) {
    if (!bindingIsManaged(binding)) continue;
    const workspace = await ctx.db.get(binding.workspaceId);
    if (workspace === null) continue;
    const owners = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", binding.workspaceId))
      .collect();
    let ours = false;
    for (const member of owners) {
      if (member.role === "owner" && (await userIsStaff(ctx, member.userId))) {
        ours = true;
        break;
      }
    }
    out.push({ workspaceId: binding.workspaceId, slug: workspace.slug, ours });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

export async function rolloutCandidatesHandler(ctx: QueryCtx): Promise<ManagedWorkspace[]> {
  await requireAdmin(ctx);
  return await managedWorkspaces(ctx);
}

const STATE_ORDER: Record<string, number> = {
  failed: 0,
  encrypting: 1,
  checking: 2,
  waiting: 3,
  encrypted: 4,
};

export async function rolloutStatusHandler(ctx: QueryCtx) {
  await requireAdmin(ctx);
  const rollout = await rolloutRow(ctx);
  const managed = await managedWorkspaces(ctx);
  const counts = { waiting: 0, encrypting: 0, checking: 0, encrypted: 0, failed: 0, notStarted: 0 };
  let filesDone = 0;
  let filesTotal = 0;
  const workspaces = [];
  for (const workspace of managed) {
    const row = await workspaceEncryptionRow(ctx, workspace.workspaceId);
    if (row === null) {
      counts.notStarted += 1;
      continue;
    }
    counts[row.state] += 1;
    const total = row.state === "encrypted" ? row.filesTotal ?? row.filesDone : row.filesTotal;
    filesDone += row.state === "encrypted" ? total ?? 0 : row.filesDone;
    filesTotal += total ?? 0;
    workspaces.push({
      workspaceId: workspace.workspaceId,
      slug: workspace.slug,
      state: row.state,
      filesDone: row.filesDone,
      ...(total === undefined ? {} : { filesTotal: total }),
      ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }),
      updatedAt: row.updatedAt,
    });
  }
  workspaces.sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.slug.localeCompare(b.slug),
  );
  return {
    state: rollout?.state ?? ("off" as const),
    ...(rollout === null
      ? {}
      : {
          scope: rollout.scope,
          acceptsNew: rollout.acceptsNew,
          ...(rollout.startedBy === undefined ? {} : { startedBy: rollout.startedBy }),
          ...(rollout.startedAt === undefined ? {} : { startedAt: rollout.startedAt }),
          ...(rollout.changedBy === undefined ? {} : { changedBy: rollout.changedBy }),
          ...(rollout.pauseReason === undefined ? {} : { pauseReason: rollout.pauseReason }),
          updatedAt: rollout.updatedAt,
        }),
    managedTotal: managed.length,
    counts,
    files: { done: filesDone, total: filesTotal },
    workspaces,
  };
}

async function writeRollout(ctx: MutationCtx, patch: Partial<Rollout> & { state: Rollout["state"] }) {
  const existing = await rolloutRow(ctx);
  const now = Date.now();
  if (existing === null) {
    await ctx.db.insert("managedEncryptionRollout", {
      scope: "ours",
      acceptsNew: false,
      ...patch,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
  }
}

async function enroll(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  if ((await workspaceEncryptionRow(ctx, workspaceId)) !== null) return false;
  await ctx.db.insert("managedEncryptionWorkspaces", {
    workspaceId,
    state: "waiting",
    filesDone: 0,
    runId: 0,
    updatedAt: Date.now(),
  });
  return true;
}

export async function startRolloutHandler(
  ctx: MutationCtx,
  args: { scope: RolloutScope; workspaceIds?: Id<"workspaces">[] },
): Promise<{ added: number; targets: number }> {
  const actor = await requireAdmin(ctx);
  const rollout = await rolloutRow(ctx);
  if (rollout?.state === "running") {
    throw new ConvexError({ code: "ROLLOUT_RUNNING", message: "The rollout is already running." });
  }
  const managed = await managedWorkspaces(ctx);
  let targets: ManagedWorkspace[];
  if (args.scope === "all") targets = managed;
  else if (args.scope === "ours") targets = managed.filter((workspace) => workspace.ours);
  else {
    const picked = new Set((args.workspaceIds ?? []).map(String));
    targets = managed.filter((workspace) => picked.has(String(workspace.workspaceId)));
    if (targets.length === 0 || targets.length !== picked.size) {
      throw new ConvexError({
        code: "PICK_NOT_MANAGED",
        message: "Pick at least one workspace, and only workspaces on managed storage.",
      });
    }
  }
  let added = 0;
  for (const target of targets) if (await enroll(ctx, target.workspaceId)) added += 1;
  await writeRollout(ctx, {
    state: "running",
    scope: args.scope,
    acceptsNew: args.scope === "all",
    startedBy: actor.email,
    startedAt: Date.now(),
    changedBy: actor.email,
    pauseReason: undefined,
  });
  await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.tick, { restartActive: true });
  return { added, targets: targets.length };
}

export async function pauseRolloutHandler(ctx: MutationCtx, args: { reason: string }): Promise<null> {
  const actor = await requireAdmin(ctx);
  const reason = args.reason.trim().slice(0, 200);
  if (!reason) throw new ConvexError({ code: "REASON_REQUIRED", message: "Say why, in one line." });
  const rollout = await rolloutRow(ctx);
  if (rollout?.state !== "running") {
    throw new ConvexError({ code: "NOT_RUNNING", message: "Only a running rollout can be paused." });
  }
  await writeRollout(ctx, { state: "paused", pauseReason: reason, changedBy: actor.email });
  return null;
}

export async function resumeRolloutHandler(ctx: MutationCtx): Promise<null> {
  const actor = await requireAdmin(ctx);
  const rollout = await rolloutRow(ctx);
  if (rollout?.state !== "paused" && rollout?.state !== "failed") {
    throw new ConvexError({ code: "NOT_PAUSED", message: "Only a paused or stopped rollout can resume." });
  }
  await writeRollout(ctx, { state: "running", pauseReason: undefined, changedBy: actor.email });
  await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.tick, { restartActive: true });
  return null;
}

export async function retryWorkspaceHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<null> {
  const actor = await requireAdmin(ctx);
  const row = await workspaceEncryptionRow(ctx, args.workspaceId);
  if (row === null || row.state !== "failed") {
    throw new ConvexError({ code: "NOT_FAILED", message: "Only a workspace that failed can be retried." });
  }
  const runId = row.runId + 1;
  await ctx.db.patch(row._id, {
    state: row.phase === "check" ? "checking" : "encrypting",
    errorCode: undefined,
    runId,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.runWalk, {
    workspaceId: args.workspaceId,
    runId,
  });
  // The rollout paused itself for this workspace. Once no workspace is left
  // failed, it carries on where it was.
  const rollout = await rolloutRow(ctx);
  const stillFailed = await ctx.db
    .query("managedEncryptionWorkspaces")
    .withIndex("by_state", (q) => q.eq("state", "failed"))
    .first();
  if (rollout?.state === "failed" && stillFailed === null) {
    await writeRollout(ctx, { state: "running", changedBy: actor.email });
    await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.tick, { restartActive: false });
  }
  return null;
}

export async function stopStartingNewHandler(ctx: MutationCtx): Promise<null> {
  const actor = await requireAdmin(ctx);
  const waiting = await ctx.db
    .query("managedEncryptionWorkspaces")
    .withIndex("by_state", (q) => q.eq("state", "waiting"))
    .collect();
  for (const row of waiting) await ctx.db.delete(row._id);
  await writeRollout(ctx, { state: "off", acceptsNew: false, pauseReason: undefined, changedBy: actor.email });
  return null;
}

async function stillManaged(ctx: QueryCtx, rows: Doc<"managedEncryptionWorkspaces">[]) {
  const out: Doc<"managedEncryptionWorkspaces">[] = [];
  for (const row of rows) {
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", row.workspaceId))
      .unique();
    if (bindingIsManaged(binding)) out.push(row);
  }
  return out;
}

/**
 * Start what may start. `restartActive` also reschedules walks that stopped
 * at a pause: their runId is bumped so any run still in flight stops itself.
 */
export async function tickHandler(ctx: MutationCtx, args: { restartActive: boolean }): Promise<null> {
  const rollout = await rolloutRow(ctx);
  const walkable = rollout !== null && (rollout.state === "running" || rollout.state === "off");
  if (!walkable) return null;
  // A workspace that moved out keeps its row (its bucket is kept for a week),
  // but it neither holds a walk slot nor keeps the rollout from completing.
  const active = await stillManaged(ctx, [
    ...(await ctx.db.query("managedEncryptionWorkspaces").withIndex("by_state", (q) => q.eq("state", "encrypting")).collect()),
    ...(await ctx.db.query("managedEncryptionWorkspaces").withIndex("by_state", (q) => q.eq("state", "checking")).collect()),
  ]);
  const schedule = async (row: Doc<"managedEncryptionWorkspaces">) => {
    const runId = row.runId + 1;
    await ctx.db.patch(row._id, { runId, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.runWalk, {
      workspaceId: row.workspaceId,
      runId,
    });
  };
  if (args.restartActive) for (const row of active) await schedule(row);
  if (rollout.state !== "running") return null;
  const slots = Math.max(0, WALK_CONCURRENCY - active.length);
  const waiting = await ctx.db
    .query("managedEncryptionWorkspaces")
    .withIndex("by_state", (q) => q.eq("state", "waiting"))
    .take(slots);
  for (const row of waiting) await schedule(row);
  if (active.length === 0 && waiting.length === 0) {
    const failed = await stillManaged(
      ctx,
      await ctx.db
        .query("managedEncryptionWorkspaces")
        .withIndex("by_state", (q) => q.eq("state", "failed"))
        .collect(),
    );
    if (failed.length === 0) await writeRollout(ctx, { state: "complete", changedBy: "system" });
  }
  return null;
}

/**
 * A workspace that has just got a managed bucket joins the rollout when it
 * covers every workspace. Called from managed provisioning's completion.
 */
export async function enrollNewManagedWorkspace(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
  const rollout = await rolloutRow(ctx);
  if (rollout === null || !rollout.acceptsNew) return;
  if (!(await enroll(ctx, workspaceId))) return;
  if (rollout.state === "complete") await writeRollout(ctx, { state: "running", changedBy: "system" });
  await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.tick, { restartActive: false });
}

/**
 * A workspace's binding has just become its managed bucket: newly provisioned,
 * or moved back in (a switch back within the week re-adopts the same bucket,
 * sealed files and all, then copies plain files into it).
 *
 * With no row, it joins a rollout that covers every workspace. With a row,
 * whatever the bucket holds now is unknown, so the row goes back to the start
 * of the walk: `encrypting` reads both kinds, and the walk seals what is plain.
 * Never `waiting` or no row, which would build a plain store over sealed files.
 */
export async function managedBucketBound(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
  const row = await workspaceEncryptionRow(ctx, workspaceId);
  if (row === null || row.state === "waiting") {
    await enrollNewManagedWorkspace(ctx, workspaceId);
    return;
  }
  const runId = row.runId + 1;
  await ctx.db.patch(row._id, {
    state: "encrypting",
    phase: "count",
    cursor: undefined,
    filesDone: 0,
    filesTotal: undefined,
    errorCode: undefined,
    completedAt: undefined,
    runId,
    updatedAt: Date.now(),
  });
  // Scheduled directly rather than through `tick`, which does nothing once the
  // rollout reads complete. A paused or failed rollout still stops it at
  // `walkPlan`, and Resume restarts it.
  await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.runWalk, { workspaceId, runId });
}
