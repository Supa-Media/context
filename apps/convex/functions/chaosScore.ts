/**
 * The chaos score for the app: how organized a workspace is, from 0 (calm)
 * to 100 (chaos), and what would calm it most (decided by the owner,
 * 2026-10-10; `docs/decisions/chaos-score.md`). Any member may ask, and is
 * answered from the numbers their clearance allows — see
 * `lib/filesFns/chaosOps.ts`. `available: false` means the workspace has not
 * been scored yet, or has no tree database to score it in.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import type { ChaosScoreResult } from "./lib/filesFns/chaosOps";
import { chaosScoreValidator } from "./lib/filesFns/validators";

export async function chaosScoreHandler(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; folder?: string },
): Promise<ChaosScoreResult> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "chaosScore", ...(args.folder === undefined ? {} : { folder: args.folder }) },
  });
  return result as ChaosScoreResult;
}

export const chaosScore = action({
  args: { workspaceId: v.id("workspaces"), folder: v.optional(v.string()) },
  returns: chaosScoreValidator,
  handler: async (ctx, args): Promise<ChaosScoreResult> => await chaosScoreHandler(ctx, args),
});
