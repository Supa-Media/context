/**
 * Creating and deleting one workspace's meaning index.
 *
 * `fastSearchProvision.ts`'s shape, for the same reasons: both entry points are
 * `internalAction`s reached only by a schedule edge ("scheduling is not
 * calling", `docs/decisions/storage-and-credentials.md`), every exit records a
 * status, a failure records our sentence and code and logs Cloudflare's own
 * account beside the workspace id, and a release forgets the row only once the
 * delete is confirmed.
 *
 * The credential is fast search's (`SEARCH_D1_API_TOKEN`,
 * `SEARCH_D1_ACCOUNT_ID`); its absence records `NOT_CONFIGURED` and stops, and
 * search by words carries on untouched.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, type ActionCtx } from "../_generated/server";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "./lib/d1";
import { MEANING_PASS_CHAIN } from "./lib/meaningFns/rows";
import {
  MeaningIndexError,
  deleteMeaningIndex,
  ensureMeaningIndex,
  ensureTierFilter,
  isRetryableMeaningError,
  meaningIndexNameFor,
  meaningMessageFor,
  type MeaningConfig,
} from "./lib/vectorize";

/** How long a just-created index may take to accept its filter. */
const MEANING_SETTLE_MS = 2 * 60 * 1000;
const MEANING_SETTLE_POLL_MS = 5 * 1000;

/** Both halves of the credential, or `null`. See `fastSearchProvision`'s `configFor`. */
async function configFor(ctx: ActionCtx): Promise<MeaningConfig | null> {
  const apiToken = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: D1_TOKEN_SECRET,
  });
  const accountId = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: D1_ACCOUNT_SECRET,
  });
  if (
    typeof apiToken !== "string" ||
    apiToken.length === 0 ||
    typeof accountId !== "string" ||
    accountId.length === 0
  ) {
    return null;
  }
  return { accountId, apiToken };
}

/**
 * Create the index (or adopt the one already carrying its name) and make its
 * `tier` filterable, then mark it `backfilling`.
 *
 * The name is recorded BEFORE the filter is made, for the D1 provisioner's
 * reason: an index created but not recorded is one nothing can find to delete.
 */
export const provisionMeaningIndex = internalAction({
  args: { workspaceId: v.id("workspaces"), retryUntil: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ status: string }> => {
    const row = await ctx.runQuery(internal.functions.meaningSearch.indexForWorkspace, {
      workspaceId: args.workspaceId,
    });
    // Turned off, or never turned on, between the schedule and now.
    if (row === null || !row.enabled) return { status: "skipped" };

    const config = await configFor(ctx);
    if (config === null) {
      await ctx.runMutation(internal.functions.meaningSearch.recordProvisionResult, {
        workspaceId: args.workspaceId,
        status: "failed",
        errorCode: "NOT_CONFIGURED",
        error: meaningMessageFor("NOT_CONFIGURED"),
      });
      return { status: "failed" };
    }

    try {
      let indexName = row.indexName;
      let created = false;
      if (indexName === undefined) {
        const { index } = await ensureMeaningIndex(config, meaningIndexNameFor(args.workspaceId));
        indexName = index.name;
        created = true;
        await ctx.runMutation(internal.functions.meaningSearch.recordProvisionResult, {
          workspaceId: args.workspaceId,
          status: "provisioning",
          indexName,
        });
      }
      await ensureTierFilter(config, indexName);
      await ctx.runMutation(internal.functions.meaningSearch.recordProvisionResult, {
        workspaceId: args.workspaceId,
        status: "backfilling",
        indexName,
        ...(created ? { notesIndexed: 0 } : {}),
      });
      // The catch-up pass, after the status it checks is recorded. Scheduled,
      // not called: it opens a bucket, which only the barrier may do.
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        // Scope-blind: the tier a note is embedded at is `privacy.md`'s per note.
        scope: "private",
        operation: { kind: "projectMeaning", passes: MEANING_PASS_CHAIN },
      });
      return { status: "backfilling" };
    } catch (error) {
      const code = error instanceof MeaningIndexError ? error.code : "REFUSED";
      console.error("meaning_search.provision_failed", {
        workspaceId: args.workspaceId,
        code,
        detail: error instanceof MeaningIndexError ? error.detail : "",
      });
      const deadline = args.retryUntil ?? Date.now() + MEANING_SETTLE_MS;
      const remaining = deadline - Date.now();
      if (isRetryableMeaningError(code) && remaining > 0) {
        // A plain delay argument: the reachability graph reads the target as
        // the second argument and cannot see past a call in the first.
        const delay = Math.min(MEANING_SETTLE_POLL_MS, remaining);
        await ctx.scheduler.runAfter(
          delay,
          internal.functions.meaningProvision.provisionMeaningIndex,
          { workspaceId: args.workspaceId, retryUntil: deadline },
        );
        return { status: "provisioning" };
      }
      await ctx.runMutation(internal.functions.meaningSearch.recordProvisionResult, {
        workspaceId: args.workspaceId,
        status: "failed",
        errorCode: code,
        error: meaningMessageFor(code),
      });
      return { status: "failed" };
    }
  },
});

/**
 * Delete the index of a workspace that turned meaning search off (or is being
 * deleted), then forget the row. A failure leaves the row `releasing`.
 */
export const releaseMeaningIndex = internalAction({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<{ released: boolean }> => {
    const row = await ctx.runQuery(internal.functions.meaningSearch.indexForWorkspace, {
      workspaceId: args.workspaceId,
    });
    if (row === null) return { released: true };
    // Turned back on while this was in flight; the provisioner owns it now.
    if (row.enabled) return { released: false };
    if (row.indexName !== undefined) {
      const config = await configFor(ctx);
      if (config === null) return { released: false };
      try {
        await deleteMeaningIndex(config, row.indexName);
      } catch (error) {
        console.error("meaning_search.release_failed", {
          workspaceId: args.workspaceId,
          code: error instanceof MeaningIndexError ? error.code : "REFUSED",
        });
        return { released: false };
      }
    }
    await ctx.runMutation(internal.functions.meaningSearch.forgetIndex, {
      workspaceId: args.workspaceId,
    });
    return { released: true };
  },
});
