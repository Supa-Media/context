/**
 * The internal handlers behind `fastSearch.ts`'s provisioning pipeline:
 * `bindingForWorkspace`, `projectionTargetForWorkspace`,
 * `recordProvisionResult`, `recordProjectionProgress`, `forgetIndex` and
 * `sweepStalledBackfills`.
 *
 * Split out of `functions/fastSearch.ts` — see that file's header for the
 * gate this surfaces and the owner-only rules around it, and see each
 * export's own doc comment there for its rules.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { BACKFILL_STALL_MS, PROJECTION_CHAIN, searchProjectionState, type SearchProjectionState } from "../fastSearch";
import { bindingFor, planFor } from "./helpers";

/** Contexts one sweep may restart. See `sweepStalledBackfillsHandler`. */
const SWEEP_BATCH = 50;

export async function bindingForWorkspaceHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<Doc<"searchIndexes"> | null> {
  return await bindingFor(ctx, args.workspaceId);
}

export async function projectionTargetForWorkspaceHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{ databaseId: string; state: SearchProjectionState } | null> {
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null) return null;
  const binding = await bindingFor(ctx, args.workspaceId);
  const plan = await planFor(ctx, args.workspaceId);
  const state = searchProjectionState(workspace, plan, binding);
  if (state === null) return null;
  return { databaseId: binding!.databaseId as string, state };
}

export async function recordProvisionResultHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    generation?: "premium-v1";
    status: "provisioning" | "backfilling" | "ready" | "failed";
    databaseId?: string;
    databaseName?: string;
    schemaVersion?: number;
    errorCode?: string;
    error?: string;
    notesIndexed?: number;
    notesPending?: number;
  },
): Promise<{ applied: boolean }> {
  const existing = await bindingFor(ctx, args.workspaceId);
  if (existing === null) return { applied: false };
  if (
    args.generation !== undefined &&
    existing.generation !== args.generation
  ) {
    return { applied: false };
  }
  if (!existing.optedIn) {
    // Opted out while this was in flight. The database id is still recorded
    // if the provisioner learned one, because the release needs it — but the
    // status stays `releasing` and nothing starts serving.
    if (args.databaseId !== undefined && existing.databaseId === undefined) {
      await ctx.db.patch(existing._id, {
        databaseId: args.databaseId,
        databaseName: args.databaseName,
        updatedAt: Date.now(),
      });
    }
    return { applied: false };
  }

  await ctx.db.patch(existing._id, {
    status: args.status,
    databaseId: args.databaseId ?? existing.databaseId,
    databaseName: args.databaseName ?? existing.databaseName,
    schemaVersion: args.schemaVersion ?? existing.schemaVersion,
    errorCode: args.errorCode,
    error: args.error,
    notesIndexed: args.notesIndexed ?? existing.notesIndexed,
    notesPending: args.notesPending ?? existing.notesPending,
    updatedAt: Date.now(),
  });
  return { applied: true };
}

export async function recordProjectionProgressHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    notesIndexed: number;
    notesPending: number;
    /** The gateway saying the backfill is finished. */
    ready: boolean;
  },
): Promise<{ applied: boolean }> {
  // Re-checked here and not only at the door. The door is one caller; this is
  // the invariant, and a count that is not a non-negative integer would be
  // rendered as a percentage of something.
  if (
    !Number.isInteger(args.notesIndexed) ||
    !Number.isInteger(args.notesPending) ||
    args.notesIndexed < 0 ||
    args.notesPending < 0
  ) {
    return { applied: false };
  }

  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null) return { applied: false };
  const binding = await bindingFor(ctx, args.workspaceId);
  const plan = await planFor(ctx, args.workspaceId);
  // The same gate that decided the credential could be handed over. A row
  // that is `releasing`, `failed`, `provisioning`, opted out or unentitled is
  // refused here, by the one function that knows what "serving" means.
  const state = searchProjectionState(workspace, plan, binding);
  if (state === null) return { applied: false };

  await ctx.db.patch(binding!._id, {
    notesIndexed: args.notesIndexed,
    notesPending: args.notesPending,
    // Only `backfilling` → `ready`. `state` is one of two values here, so a
    // report of `ready` against an already-ready row keeps it ready and a
    // report without `ready` never demotes one — a gateway that reports
    // progress after finishing must not restart the spinner.
    status: args.ready ? "ready" : binding!.status,
    updatedAt: Date.now(),
  });
  return { applied: true };
}

export async function forgetIndexHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{ forgotten: boolean }> {
  const existing = await bindingFor(ctx, args.workspaceId);
  if (existing === null) return { forgotten: false };
  // Only a row that is actually released. A row somebody re-enabled while
  // the delete was in flight must survive — the provisioner will make it a
  // new database, and forgetting it here would strand that one instead.
  if (existing.optedIn || existing.status !== "releasing") {
    return { forgotten: false };
  }
  await ctx.db.delete(existing._id);
  return { forgotten: true };
}

export async function sweepStalledBackfillsHandler(
  ctx: MutationCtx,
): Promise<{ started: number }> {
  const now = Date.now();
  const rows = await ctx.db
    .query("searchIndexes")
    .withIndex("by_status", (q) => q.eq("status", "backfilling"))
    // Bounded, like every other sweep here: a backlog drains over several
    // runs rather than in one transaction big enough to hit a limit.
    .take(SWEEP_BATCH);

  let started = 0;
  for (const row of rows) {
    // A `backfilling` row that is not opted in should not exist — `disable`
    // moves it to `releasing` — but a status index is a poor place to trust
    // an invariant that lives on another field.
    if (!row.optedIn) continue;
    if (now - row.updatedAt < BACKFILL_STALL_MS) continue;
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId: row.workspaceId,
      scope: "private",
      operation: { kind: "projectIndex", passes: PROJECTION_CHAIN },
    });
    started += 1;
  }
  return { started };
}
