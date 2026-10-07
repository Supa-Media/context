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
 */
export async function enableMeaningHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; by?: Id<"users"> },
): Promise<{ scheduled: boolean }> {
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null) return { scheduled: false };
  const now = Date.now();
  const row = await meaningRowFor(ctx, args.workspaceId);
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
 * Turn it off. With no index yet there is nothing remote to delete and the row
 * goes now; otherwise it serves nothing from this moment and the delete is
 * scheduled.
 */
export async function disableMeaningHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{ releasing: boolean }> {
  const row = await meaningRowFor(ctx, args.workspaceId);
  if (row === null) return { releasing: false };
  if (row.indexName === undefined) {
    await ctx.db.delete(row._id);
    return { releasing: false };
  }
  await ctx.db.patch(row._id, { enabled: false, status: "releasing", updatedAt: Date.now() });
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
    status: Exclude<MeaningRowStatus, "releasing">;
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

/** Remove a row whose index is confirmed gone, unless it was turned back on. */
export async function forgetMeaningIndexHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<void> {
  const row = await meaningRowFor(ctx, args.workspaceId);
  if (row === null || row.enabled) return;
  await ctx.db.delete(row._id);
}
