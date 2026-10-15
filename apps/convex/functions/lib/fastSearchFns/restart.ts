/**
 * Starting a fast search copy again: the sweep's restart, and staff's.
 *
 * The copy chain stops on a link that moved nothing, and only the
 * fifteen-minute sweep picks a `backfilling` row up again, after fifteen
 * quiet minutes. That is right for a chain nobody is watching and slow for
 * one somebody just unblocked: after Seal again made @segunawe's last two
 * notes readable (2026-10-14), search by meaning finished on its Restart and
 * fast search sat on "Indexing 4 of 6" with no button beside it. This is that
 * button's work, and the sweep's, in one place.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { D1_SCHEMA_VERSION } from "../d1";
import { FAST_SEARCH_GENERATION, PROJECTION_CHAIN, fastSearchEntitled } from "../fastSearch";
import { workspaceArchived } from "../archivedWorkspaces";
import { bindingFor } from "./helpers";

/**
 * Put a `failed` row back where it failed out of and schedule its work: the
 * copy resumes at its cursor with counters kept when its database is current,
 * and anything short of that is made again (`provisionIndex` reuses a
 * recorded database rather than creating a second one).
 */
export async function resumeFailedRow(ctx: MutationCtx, row: Doc<"searchIndexes">, now: number): Promise<void> {
  const provisioned =
    typeof row.databaseId === "string" &&
    row.databaseId.length > 0 &&
    row.schemaVersion === D1_SCHEMA_VERSION;
  await ctx.db.patch(row._id, {
    status: provisioned ? "backfilling" : "provisioning",
    errorCode: undefined,
    error: undefined,
    chainedAt: now,
    updatedAt: now,
  });
  if (provisioned) {
    await scheduleCopy(ctx, row.workspaceId);
  } else {
    await ctx.scheduler.runAfter(0, internal.functions.fastSearchProvision.provisionIndex, {
      workspaceId: row.workspaceId,
      generation: FAST_SEARCH_GENERATION,
    });
  }
}

/** The copy chain, from its cursor. */
export async function scheduleCopy(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    operation: { kind: "projectIndex", passes: PROJECTION_CHAIN },
  });
}

export type FastSearchRestartOutcome =
  | "restarted"
  | "noWorkspace"
  | "off"
  | "archived"
  | "ready"
  | "running"
  | "busy";

/**
 * Staff: start one workspace's copy again now, failed or not. Never turns on
 * a copy its owner (or the rollout) has not: a row that is off stays off.
 *
 * - `failed`: resumed whatever its code, since a person pressed it.
 * - `backfilling`: the chain again from its cursor, unless a pass holds the
 *   lease (`running`), so two passes never share one database on purpose.
 * - `provisioning`: left alone (`running`): a second `provisionIndex` beside
 *   one still creating the database could create two.
 * - `ready`: nothing to restart; the gateway's searches keep it current.
 */
export async function restartFastSearchIndex(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<FastSearchRestartOutcome> {
  const workspace = await ctx.db.get(workspaceId);
  if (workspace === null) return "noWorkspace";
  const row = await bindingFor(ctx, workspaceId);
  if (row === null || !row.optedIn || !fastSearchEntitled(workspace)) return "off";
  if (await workspaceArchived(ctx.db, workspace)) return "archived";
  const now = Date.now();
  switch (row.status) {
    case "ready":
      return "ready";
    case "failed":
      if (row.generation !== FAST_SEARCH_GENERATION) return "busy";
      await resumeFailedRow(ctx, row, now);
      return "restarted";
    case "backfilling":
      if (row.projectionLease && row.projectionLease.until > now) return "running";
      await ctx.db.patch(row._id, { chainedAt: now });
      await scheduleCopy(ctx, workspaceId);
      return "restarted";
    case "provisioning":
      return "running";
    default:
      // `releasing` or `off`: on its way out.
      return "busy";
  }
}
