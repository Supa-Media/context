/**
 * The barrier's half of search by meaning's catch-up pass: decide whether the
 * pass has an index to fill before any bucket is opened, build its index
 * client and embedder, run it over the store the barrier opened, and record
 * what it found.
 *
 * Split out of `fileOperationBarrier.ts` for size; it runs inside that
 * barrier, which is the only place a bucket credential is opened. Its own
 * credential is ours (`SEARCH_D1_API_TOKEN`), read here as `projectionOutcome`'s
 * sibling reads it for fast search.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { createMeaningClient } from "../../../../mcp/src/search/meaning/client.js";
import { createRestEmbedder } from "../../../../mcp/src/search/meaning/embed.js";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "../d1";
import { projectMeaningIndex, type MeaningPassResult } from "../fileOps/meaningProjection";
import { MEANING_PASS_CHAIN } from "../meaningFns/rows";
import { isRetryableMeaningError, meaningMessageFor } from "../vectorize";
import type { FileStore } from "../fileOps/store";
import { IDLE_MEANING } from "./operationTypes";

/** A blip waits this long before its link is retried. */
const MEANING_PASS_RETRY_MS = 30 * 1000;

export interface MeaningPassContext {
  client: ReturnType<typeof createMeaningClient>;
  embed: (texts: string[]) => Promise<number[][]>;
  generation: string;
}

type MeaningResult = Omit<MeaningPassResult, "failure"> & { kind: "meaningProjected"; failure?: string };

/**
 * The index this pass may fill, or `null` to do nothing. Asked before the
 * bucket is opened, so a pass for an index turned off meanwhile decrypts
 * nothing on its way to doing nothing (fast search's ordering, same reason).
 * A deployment with no credential says so on the row.
 */
export async function meaningPassContext(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<MeaningPassContext | null> {
  const target = await ctx.runQuery(internal.functions.meaningSearch.writeTargetForWorkspace, { workspaceId });
  if (target === null) return null;
  const apiToken = await ctx.runAction(internal.functions.admin.readIntegrationSecret, { name: D1_TOKEN_SECRET });
  const accountId = await ctx.runAction(internal.functions.admin.readIntegrationSecret, { name: D1_ACCOUNT_SECRET });
  if (typeof apiToken !== "string" || !apiToken || typeof accountId !== "string" || !accountId) {
    await ctx.runMutation(internal.functions.meaningSearch.recordProvisionResult, {
      workspaceId,
      status: "failed",
      errorCode: "NOT_CONFIGURED",
      error: meaningMessageFor("NOT_CONFIGURED"),
    });
    return null;
  }
  const descriptor = { indexName: target.indexName, accountId, apiToken, state: target.state };
  return {
    client: createMeaningClient(descriptor),
    // Non-null: both halves were checked just above.
    embed: createRestEmbedder({ accountId, apiToken }) as (texts: string[]) => Promise<number[][]>,
    generation: target.generation,
  };
}

/** Run one link, record it, and schedule the next where there is one. */
export async function runMeaningPass(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team"; operation: { passes?: number } },
  store: FileStore,
  meaning: MeaningPassContext,
): Promise<MeaningResult> {
  const passes = Math.max(0, Math.floor(args.operation.passes ?? 0));
  const pass = await projectMeaningIndex(store, meaning);
  const next = (delay: number) =>
    ctx.scheduler.runAfter(delay, internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: args.scope,
      operation: { kind: "projectMeaning", passes: passes - 1 },
    });

  if (pass.failure !== null) {
    const retrying = isRetryableMeaningError(pass.failure) && passes > 0;
    // Our code and counts, beside the workspace id: no path, no text, no provider words.
    console.error("meaning_search.pass_failed", {
      workspaceId: args.workspaceId,
      code: pass.failure,
      embeddedThisPass: pass.embedded,
      passesLeft: passes,
      retrying,
    });
    if (retrying) {
      await next(MEANING_PASS_RETRY_MS);
    } else {
      // A failure waiting cannot fix goes on the row; the sweep retries the
      // ones it can after its own quiet window.
      await ctx.runMutation(internal.functions.meaningSearch.recordProvisionResult, {
        workspaceId: args.workspaceId,
        status: "failed",
        errorCode: pass.failure,
        error: meaningMessageFor(pass.failure),
      });
    }
    const { failure, ...counts } = pass;
    return { kind: "meaningProjected", ...counts, failure };
  }

  if (pass.moved || pass.ready) {
    await ctx.runMutation(internal.functions.meaningSearch.recordProgress, {
      workspaceId: args.workspaceId,
      notesIndexed: pass.notesIndexed,
      notesPending: pass.notesPending,
      ready: pass.ready,
    });
  }
  if (pass.moved && !pass.ready && passes > 0) await next(0);
  const { failure: _none, ...counts } = pass;
  return { kind: "meaningProjected", ...counts };
}

export { IDLE_MEANING, MEANING_PASS_CHAIN };
