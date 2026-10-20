/**
 * The retired historical Gmail backfill's refusal.
 *
 * #388 removed the backfill; a run row queued before then, or started by an
 * old client, is stopped here with a reason a person can read rather than
 * left pending. Moved out of `forwardSync.ts`, which keeps the forward pass.
 * Runs inside the credential barrier `runFileOperation`, and is reached from
 * nowhere else.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { OperationResult } from "./operationTypes";

export async function runGoogleGmailBackfill(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  runId: Id<"googleSyncRuns">,
): Promise<Extract<OperationResult, { kind: "googleSyncRun" }>> {
  const job = await ctx.runQuery(internal.functions.googleConnect.googleGmailBackfillForRun, {
    workspaceId,
    runId,
  });
  if (job === null) {
    return {
      kind: "googleSyncRun",
      runId,
      status: "complete",
      totalUnits: 0,
      completedUnits: 0,
      itemsFound: 0,
      daysWithMail: 0,
      bytesWritten: 0,
      continue: false,
    };
  }

  await ctx.runMutation(internal.functions.googleConnect.stopGoogleGmailBackfillRun, {
    workspaceId,
    runId,
    errorCode: "GOOGLE_GMAIL_BACKFILL_DISABLED",
    message: "Historical Gmail imports are disabled. This account will sync new mail from its current position.",
  });
  return {
    kind: "googleSyncRun",
    runId,
    status: "failed",
    totalUnits: job.totalUnits,
    completedUnits: job.completedUnits,
    itemsFound: 0,
    daysWithMail: 0,
    bytesWritten: 0,
    continue: false,
  };
}
