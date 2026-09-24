/**
 * Recent durable folder moves, for the owner's settings card.
 *
 * The handler body of `listDurableMoves`, which `functions/files.ts` registers
 * with its args and return validator; moved verbatim.
 */

import type { QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { requireWorkspaceRole } from "../workspaceAuth";
import { callerId } from "./access";

export async function listDurableMovesHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
) {
  const actorUserId = await callerId(ctx);
  await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
  const rows = await ctx.db
    .query("gatewayJobs")
    .withIndex("by_workspace_updatedAt", (q) => q.eq("workspaceId", args.workspaceId))
    .order("desc")
    .take(20);
  const completedCutoff = Date.now() - 24 * 60 * 60 * 1_000;
  return rows
    .filter((row) => row.status !== "complete" || row.updatedAt >= completedCutoff)
    .slice(0, 10)
    .map((row) => ({
      jobId: row._id,
      status: row.status,
      ...(row.progressPhase === undefined ? {} : { phase: row.progressPhase }),
      ...(row.progressCompleted === undefined ? {} : { completed: row.progressCompleted }),
      ...(row.progressTotal === undefined ? {} : { total: row.progressTotal }),
      updatedAt: row.updatedAt,
    }));
}
