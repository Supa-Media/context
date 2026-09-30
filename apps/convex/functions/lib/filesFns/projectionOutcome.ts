/**
 * What the barrier does with a finished projection pass: record it, retry it,
 * or chain the next link.
 *
 * Split out of `fileOperationBarrier.ts`, which runs the pass. Nothing here
 * opens a credential: it writes rows and schedules jobs, and scheduling from
 * inside the barrier propagates no taint.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { isRetryableD1Error, messageFor } from "../d1";
import { PROJECTION_RETRY_MS } from "../fastSearch";
import type { OperationResult } from "./operationTypes";

type ProjectedResult = Extract<OperationResult, { kind: "indexProjected" }>;

export async function recordProjectionOutcome(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    scope: "private" | "team";
    operation: { kind: string; passes?: number };
  },
  result: ProjectedResult,
): Promise<void> {
  const passes = Math.floor(args.operation.kind === "projectIndex"
    ? args.operation.passes ?? 0
    : 0);

  if (result.failure !== undefined) {
    const retrying = isRetryableD1Error(result.failure) && passes > 0;
    /*
      THE LINE SOMEBODY DIAGNOSING THIS NEEDS, WRITTEN EVERY TIME.

      This path wrote nothing to the logs, and the code alone cannot tell a
      timeout from a 503 from a dropped connection: all three are
      `UNAVAILABLE`. The detail is ours (a cause from a closed set, the verb
      and table of our own SQL, a duration), next to the workspace id and
      nothing else: no path, no note text, no provider message, no token.
    */
    console.error("fast_search.projection_failed", {
      workspaceId: args.workspaceId,
      code: result.failure,
      cause: result.failureDetail?.cause ?? null,
      statement: result.failureDetail?.statement ?? null,
      elapsedMs: result.failureDetail?.elapsedMs ?? null,
      projectedThisPass: result.projected,
      passesLeft: passes,
      retrying,
    });
    /*
      A BLIP IS A WAIT, NOT A VERDICT.

      This used to record `failed` on any failure, and the row then said
      "Cloudflare could not be reached. This will retry." while nothing
      retried: `failed` is outside `backfilling`, so the chain stopped and
      the sweep did not look at it. A person watched a card promise a retry at
      84% and nothing came. A failure waiting can fix spends one link of the
      chain on a delayed retry instead, and writes nothing, so the card keeps
      saying "Preparing", which is true. Only a chain that has run out of
      links records the failure, and the sweep restarts that one too.
    */
    if (retrying) {
      await ctx.scheduler.runAfter(
        PROJECTION_RETRY_MS,
        internal.functions.files.runFileOperation,
        {
          workspaceId: args.workspaceId,
          scope: args.scope,
          operation: { kind: "projectIndex", passes: passes - 1 },
        },
      );
      return;
    }
    /*
      A failure goes to `recordProvisionResult` rather than to the progress
      mutation: a failed pass's counters are zero because they are only
      computed when something moved, and reporting them would write "no notes
      found" onto the row. `failed` is a state the console already renders.
    */
    await ctx.runMutation(internal.functions.fastSearch.recordProvisionResult, {
      workspaceId: args.workspaceId,
      status: "failed",
      errorCode: result.failure,
      error: messageFor(result.failure),
    });
    return;
  }

  // The gateway's copy of this posts to `/gateway/search-index/progress`;
  // there is no hop to make from inside the control plane, so the same
  // internal mutation the route calls is called directly.
  if (result.report) {
    await ctx.runMutation(internal.functions.fastSearch.recordProjectionProgress, {
      workspaceId: args.workspaceId,
      notesIndexed: result.notesIndexed,
      notesPending: result.notesPending,
      ready: result.ready,
    });
  }
  // Only a link that made progress and did not finish schedules the next.
  if (result.moved && !result.ready && passes > 0) {
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: args.scope,
      operation: { kind: "projectIndex", passes: passes - 1 },
    });
  }
}
