/**
 * The admin console's view of search by meaning: every workspace's index row,
 * and a way for staff to start indexing again.
 *
 * Asked for by the owner, 2026-10-07, after the first rollout stopped every
 * workspace larger than one pass and the only place the reason lived was a row
 * nobody could read ("make sure I can restart indexing from admin tab").
 *
 * What staff see is what the row holds: a slug, a status, our own error code
 * and cause, and counts. Never a path, a title or a note's text.
 *
 * ## What a restart does, and what it never does
 *
 *  - It keeps the row's generation (`enabledAt`), so the map in the bucket
 *    still counts and the walk resumes where it stopped rather than embedding
 *    everything again.
 *  - It never turns on a workspace whose owner switched search by meaning off.
 *    That is the owner's decision (`rows.ts`), and staff do not overrule it.
 *  - A workspace with no row yet is turned on exactly as "on for everyone"
 *    would have, just sooner.
 */

import { v } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { meaningStatusValidator } from "../schema/meaning";
import { MEANING_PASS_CHAIN, enableMeaningHandler, meaningRowFor } from "../meaningFns/rows";

/** Rows the report reads. Far above today's estate; the report says when it stopped short. */
const REPORT_ROWS = 1_000;

export const meaningIndexRowValidator = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.union(v.string(), v.null()),
  kind: v.union(v.literal("personal"), v.literal("shared"), v.null()),
  enabled: v.boolean(),
  status: meaningStatusValidator,
  errorCode: v.union(v.string(), v.null()),
  errorCause: v.union(v.string(), v.null()),
  notesIndexed: v.union(v.number(), v.null()),
  notesPending: v.union(v.number(), v.null()),
  updatedAt: v.number(),
});

export const meaningIndexReportValidator = v.object({
  rows: v.array(meaningIndexRowValidator),
  truncated: v.boolean(),
});

export type MeaningIndexReport = typeof meaningIndexReportValidator.type;

/** Failed rows first, then the ones still filling, then the rest; each by slug. */
const ORDER: Record<Doc<"meaningIndexes">["status"], number> = {
  failed: 0,
  provisioning: 1,
  backfilling: 2,
  ready: 3,
  releasing: 4,
  off: 5,
};

export async function meaningIndexReportHandler(ctx: QueryCtx): Promise<MeaningIndexReport> {
  const found = await ctx.db.query("meaningIndexes").take(REPORT_ROWS + 1);
  const truncated = found.length > REPORT_ROWS;
  const rows = await Promise.all(
    found.slice(0, REPORT_ROWS).map(async (row) => {
      const workspace = await ctx.db.get(row.workspaceId);
      return {
        workspaceId: row.workspaceId,
        slug: workspace?.slug ?? null,
        kind: workspace?.kind ?? null,
        enabled: row.enabled,
        status: row.status,
        errorCode: row.errorCode ?? null,
        errorCause: row.errorCause ?? null,
        notesIndexed: row.notesIndexed ?? null,
        notesPending: row.notesPending ?? null,
        updatedAt: row.updatedAt,
      };
    }),
  );
  rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.slug ?? "").localeCompare(b.slug ?? ""));
  return { rows, truncated };
}

export type MeaningRestartOutcome = "restarted" | "turnedOff" | "busy" | "noWorkspace";

/**
 * Start one workspace's indexing again. Returns what happened rather than
 * throwing, so "restart every failed one" can report each.
 */
export async function restartMeaningIndex(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<MeaningRestartOutcome> {
  if ((await ctx.db.get(workspaceId)) === null) return "noWorkspace";
  const row = await meaningRowFor(ctx, workspaceId);
  if (row === null) {
    // Not reached by "on for everyone" yet: turn it on the way it would have.
    const { scheduled } = await enableMeaningHandler(ctx, { workspaceId, auto: true });
    return scheduled ? "restarted" : "busy";
  }
  if (!row.enabled) return "turnedOff";
  const now = Date.now();
  if (row.status === "failed" || row.status === "provisioning") {
    // Back through the provisioner, which adopts the existing index, makes
    // sure of its filter, and starts the walk. The generation is kept.
    await ctx.db.patch(row._id, {
      status: "provisioning",
      errorCode: undefined,
      errorCause: undefined,
      error: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.functions.meaningProvision.provisionMeaningIndex, { workspaceId });
    return "restarted";
  }
  if (row.status === "backfilling" || row.status === "ready") {
    // Touched now, so the sweep does not start a second walk beside this one.
    await ctx.db.patch(row._id, { updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "projectMeaning", passes: MEANING_PASS_CHAIN },
    });
    return "restarted";
  }
  // `releasing` or `off`: on its way out, nothing to restart.
  return "busy";
}

/** Every failed row, and every one still filling, started again. Bounded per call. */
export async function restartStuckMeaningIndexes(ctx: MutationCtx): Promise<{ restarted: number }> {
  // Read every row first: a failed row becomes `provisioning` as it restarts,
  // and reading statuses one after another would restart it twice.
  const stuck: Id<"workspaces">[] = [];
  for (const status of ["failed", "provisioning", "backfilling"] as const) {
    const rows = await ctx.db
      .query("meaningIndexes")
      .withIndex("by_status", (q) => q.eq("status", status))
      .take(REPORT_ROWS);
    stuck.push(...rows.map((row) => row.workspaceId));
  }
  let restarted = 0;
  for (const workspaceId of stuck) {
    if ((await restartMeaningIndex(ctx, workspaceId)) === "restarted") restarted += 1;
  }
  return { restarted };
}
