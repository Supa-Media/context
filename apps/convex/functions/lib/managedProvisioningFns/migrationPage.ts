/**
 * The handler for `managedProvisioning.recordMigrationPage`.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { failMigrationRowAndPlan } from "./migrationFail";

/** Advance exactly the page the action read; stale duplicate pages are no-ops. */
export async function recordMigrationPageHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    expectedCursor?: string;
    nextCursor?: string;
    copied: number;
    changes: number;
    processed: number;
  },
): Promise<{ applied: boolean; cutover: boolean }> {
  const row = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (
    row === null ||
    row.status !== "copying" ||
    row.readyToCutover === true ||
    row.cursor !== args.expectedCursor ||
    !Number.isInteger(args.copied) ||
    args.copied < 0 ||
    !Number.isInteger(args.changes) ||
    args.changes < 0 ||
    !Number.isInteger(args.processed) ||
    args.processed < 0
  ) {
    return { applied: false, cutover: false };
  }
  if (
    args.nextCursor !== undefined &&
    args.nextCursor === args.expectedCursor
  ) {
    // The plan is failed alongside the row, because the console reads the
    // plan. Failing only the row left an owner watching a copy that had
    // already stopped, with no retry offered and nothing to wait for.
    await failMigrationRowAndPlan(
      ctx,
      row,
      args.workspaceId,
      "CURSOR_STALLED",
    );
    return { applied: false, cutover: false };
  }
  const objectsProcessedInPhase =
    (row.objectsProcessedInPhase ?? 0) + args.processed;
  if (row.phase === "count") {
    if (args.copied !== 0 || args.changes !== 0) {
      return { applied: false, cutover: false };
    }
    if (args.nextCursor !== undefined) {
      await ctx.db.patch(row._id, {
        cursor: args.nextCursor,
        objectsProcessedInPhase,
        updatedAt: Date.now(),
      });
      return { applied: true, cutover: false };
    }
    await ctx.db.patch(row._id, {
      phase: "copy",
      cursor: undefined,
      objectsTotal: objectsProcessedInPhase,
      objectsProcessedInPhase: 0,
      changesInPass: 0,
      updatedAt: Date.now(),
    });
    return { applied: true, cutover: false };
  }
  const changesInPass = row.changesInPass + args.changes;
  if (args.nextCursor === undefined) {
    if (row.phase === "copy") {
      await ctx.db.patch(row._id, {
        phase: "verify_source",
        cursor: undefined,
        objectsCopied: row.objectsCopied + args.copied,
        // The source is allowed to change while the migration runs. The
        // completed walk is a fresher denominator than the census that
        // preceded it, whether files were added or removed.
        // An in-flight migration created by the previous release has no
        // census. Its processed count starts at the page after its saved
        // cursor, so treating that partial remainder as a total would be a
        // lie; keep the denominator absent and use the legacy checked count.
        objectsTotal:
          row.objectsTotal === undefined
            ? undefined
            : objectsProcessedInPhase,
        objectsProcessedInPhase: 0,
        changesInPass: 0,
        updatedAt: Date.now(),
      });
      return { applied: true, cutover: false };
    }
    if (row.phase === "verify_source") {
      await ctx.db.patch(row._id, {
        phase: "verify_target",
        cursor: undefined,
        objectsCopied: row.objectsCopied + args.copied,
        objectsTotal:
          row.objectsTotal === undefined
            ? undefined
            : objectsProcessedInPhase,
        objectsProcessedInPhase: 0,
        changesInPass,
        updatedAt: Date.now(),
      });
      return { applied: true, cutover: false };
    }
    if (changesInPass > 0) {
      await ctx.db.patch(row._id, {
        phase: "verify_source",
        cursor: undefined,
        objectsCopied: row.objectsCopied + args.copied,
        objectsProcessedInPhase: 0,
        changesInPass: 0,
        readyToCutover: false,
        updatedAt: Date.now(),
      });
      return { applied: true, cutover: false };
    }
    await ctx.db.patch(row._id, {
      readyToCutover: true,
      objectsProcessedInPhase,
      updatedAt: Date.now(),
    });
    return { applied: true, cutover: true };
  }
  await ctx.db.patch(row._id, {
    cursor: args.nextCursor,
    objectsCopied: row.objectsCopied + args.copied,
    objectsProcessedInPhase,
    changesInPass,
    updatedAt: Date.now(),
  });
  return { applied: true, cutover: false };
}
