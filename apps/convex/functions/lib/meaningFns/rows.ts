/**
 * The `meaningIndexes` row's life: turned on, set up, turned off, forgotten.
 *
 * The same discipline as `lib/fastSearchFns/`: the row is the only handle on a
 * remote index, so it outlives the index rather than the other way round.
 * Turning off marks the row `releasing` and schedules the delete; the row goes
 * only once Cloudflare confirms the index is gone.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { internal } from "../../../_generated/api";
import { isRetryableMeaningError } from "../vectorize";

export type MeaningRowStatus = "provisioning" | "backfilling" | "ready" | "failed" | "releasing";

export async function meaningRowFor(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  return await ctx.db
    .query("meaningIndexes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/**
 * Turn search by meaning on for a workspace, and start setting it up.
 *
 * Idempotent: a row that is already on and not `failed` is left alone, so a
 * second call schedules nothing. A `failed` row, or one part-way through
 * releasing, is switched back on and set up again — the provisioner adopts an
 * index that is still there rather than making a second one.
 *
 * `auto` is "on for everyone" asking, and it only ever creates a row: any row
 * at all, an owner's `off` above all, means somebody already decided, and
 * Context does not decide over them.
 */
export async function enableMeaningHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; by?: Id<"users">; auto?: boolean },
): Promise<{ scheduled: boolean }> {
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null) return { scheduled: false };
  const now = Date.now();
  const row = await meaningRowFor(ctx, args.workspaceId);
  if (args.auto === true && row !== null) return { scheduled: false };
  if (row !== null && row.enabled && row.status !== "failed") return { scheduled: false };
  if (row === null) {
    await ctx.db.insert("meaningIndexes", {
      workspaceId: args.workspaceId,
      enabled: true,
      ...(args.by ? { enabledBy: args.by } : {}),
      enabledAt: now,
      status: "provisioning",
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(row._id, {
      enabled: true,
      enabledBy: args.by,
      optedOut: undefined,
      enabledAt: now,
      status: "provisioning",
      errorCode: undefined,
      error: undefined,
      updatedAt: now,
    });
  }
  await ctx.scheduler.runAfter(0, internal.functions.meaningProvision.provisionMeaningIndex, {
    workspaceId: args.workspaceId,
  });
  return { scheduled: true };
}

/**
 * Why an index is being turned off, which decides what is left afterwards:
 *
 *  - `owner`: they switched it off. The row stays, ending at `off`, so "on
 *    for everyone" never turns it back on.
 *  - `storage`: the bucket it was built from went away or changed. The index
 *    goes; the row goes too unless the owner had switched it off, so a
 *    reconnected workspace is picked up again by the rollout.
 *  - `workspace`: the workspace is being deleted. Nothing is kept.
 */
export type MeaningOffReason = "owner" | "storage" | "workspace";

/**
 * Turn it off. With no index yet there is nothing remote to delete and the row
 * ends now; otherwise it serves nothing from this moment and the delete is
 * scheduled.
 */
export async function disableMeaningHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; reason?: MeaningOffReason },
): Promise<{ releasing: boolean }> {
  const reason = args.reason ?? "workspace";
  const now = Date.now();
  const row = await meaningRowFor(ctx, args.workspaceId);
  if (row === null) {
    if (reason !== "owner") return { releasing: false };
    // Off before "on for everyone" reached this workspace: recorded, so it never does.
    await ctx.db.insert("meaningIndexes", {
      workspaceId: args.workspaceId,
      enabled: false,
      optedOut: true,
      enabledAt: now,
      status: "off",
      createdAt: now,
      updatedAt: now,
    });
    return { releasing: false };
  }
  const optedOut = reason === "owner" || (reason === "storage" && row.optedOut === true);
  if (row.indexName === undefined) {
    if (optedOut) {
      await ctx.db.patch(row._id, {
        enabled: false,
        optedOut: true,
        status: "off",
        errorCode: undefined,
        error: undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.delete(row._id);
    }
    return { releasing: false };
  }
  await ctx.db.patch(row._id, { enabled: false, optedOut, status: "releasing", updatedAt: now });
  await ctx.scheduler.runAfter(0, internal.functions.meaningProvision.releaseMeaningIndex, {
    workspaceId: args.workspaceId,
  });
  return { releasing: true };
}

/**
 * What a provisioning run found. Dropped when the row was turned off meanwhile,
 * except that a newly created index's name is still recorded: it is the only
 * handle the release has on it.
 */
export async function recordMeaningProvisionHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    status: Exclude<MeaningRowStatus, "releasing" | "off">;
    indexName?: string;
    errorCode?: string;
    error?: string;
    notesIndexed?: number;
  },
): Promise<void> {
  const row = await meaningRowFor(ctx, args.workspaceId);
  if (row === null) return;
  if (!row.enabled) {
    if (args.indexName !== undefined && row.indexName === undefined) {
      await ctx.db.patch(row._id, { indexName: args.indexName, updatedAt: Date.now() });
    }
    return;
  }
  await ctx.db.patch(row._id, {
    status: args.status,
    ...(args.indexName !== undefined ? { indexName: args.indexName } : {}),
    errorCode: args.status === "failed" ? args.errorCode : undefined,
    error: args.status === "failed" ? args.error : undefined,
    ...(args.notesIndexed !== undefined ? { notesIndexed: args.notesIndexed } : {}),
    updatedAt: Date.now(),
  });
}

/**
 * An index confirmed gone: the row is removed, or, where the owner switched it
 * off, kept as `off` with nothing left that names an index. A row turned back
 * on meanwhile is left alone.
 */
export async function forgetMeaningIndexHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<void> {
  const row = await meaningRowFor(ctx, args.workspaceId);
  if (row === null || row.enabled) return;
  if (row.optedOut === true) {
    await ctx.db.patch(row._id, {
      status: "off",
      indexName: undefined,
      notesIndexed: undefined,
      notesPending: undefined,
      errorCode: undefined,
      error: undefined,
      updatedAt: Date.now(),
    });
    return;
  }
  await ctx.db.delete(row._id);
}

/**
 * What a catch-up pass found, in counts. A `backfilling` row that reached
 * `ready` becomes `ready`; a `ready` row stays `ready` while it catches up on
 * edits, because the notes it already holds are still worth searching. A row
 * turned off, failed or releasing meanwhile is left alone.
 */
export async function recordMeaningProgressHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; notesIndexed: number; notesPending: number; ready: boolean },
): Promise<void> {
  const row = await meaningRowFor(ctx, args.workspaceId);
  if (row === null || !row.enabled) return;
  if (row.status !== "backfilling" && row.status !== "ready") return;
  await ctx.db.patch(row._id, {
    status: args.ready ? "ready" : row.status,
    notesIndexed: Math.max(0, Math.floor(args.notesIndexed)),
    notesPending: Math.max(0, Math.floor(args.notesPending)),
    updatedAt: Date.now(),
  });
}

/** A catch-up chain's length: what ends it is a pass that moved nothing or finished. */
export const MEANING_PASS_CHAIN = 200;
/** A `backfilling` row nothing has written to for this long has a dead chain. */
export const MEANING_STALL_MS = 15 * 60 * 1000;
/** A `ready` row is caught up at least this often, for edits nothing else embedded. */
export const MEANING_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A failure worth waiting out is retried after this long. */
export const MEANING_RETRY_MS = 15 * 60 * 1000;
/**
 * A failure waiting cannot fix (a missing credential or permission) is tried
 * again after this long anyway: it is fixed by somebody changing the
 * credential, and nothing tells this row when that happens.
 */
export const MEANING_CONFIG_RETRY_MS = 6 * 60 * 60 * 1000;
const MEANING_SWEEP_BATCH = 50;

/**
 * Restart what stopped: a stalled `backfilling` chain, a `ready` index due its
 * daily catch-up, and a failure whose code says waiting will fix it (which
 * goes back through the provisioner, so a lost filter is made again too), or
 * any failure after `MEANING_CONFIG_RETRY_MS`. Bounded per run; a backlog
 * drains over several. The cron runs one step of "on for everyone"
 * (`rollout.ts`) after it.
 */
export async function sweepMeaningHandler(ctx: MutationCtx): Promise<{ started: number }> {
  const now = Date.now();
  let started = 0;
  const due = async (status: "backfilling" | "ready" | "failed", olderThan: number) =>
    await ctx.db
      .query("meaningIndexes")
      .withIndex("by_status_updated", (q) => q.eq("status", status).lt("updatedAt", now - olderThan))
      .take(MEANING_SWEEP_BATCH);

  for (const row of [...(await due("backfilling", MEANING_STALL_MS)), ...(await due("ready", MEANING_REFRESH_MS))]) {
    if (!row.enabled) continue;
    // Touched now, so the next sweep does not start a second chain over it.
    await ctx.db.patch(row._id, { updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId: row.workspaceId,
      scope: "private",
      operation: { kind: "projectMeaning", passes: MEANING_PASS_CHAIN },
    });
    started += 1;
  }
  for (const row of await due("failed", MEANING_RETRY_MS)) {
    if (!row.enabled) continue;
    if (!isRetryableMeaningError(row.errorCode) && row.updatedAt >= now - MEANING_CONFIG_RETRY_MS) continue;
    await ctx.db.patch(row._id, { status: "provisioning", errorCode: undefined, error: undefined, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.functions.meaningProvision.provisionMeaningIndex, {
      workspaceId: row.workspaceId,
    });
    started += 1;
  }
  return { started };
}
