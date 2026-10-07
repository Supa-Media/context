/**
 * Search by meaning, per workspace: the row that says whether it is on, and
 * the internal steps that set its index up and tear it down.
 *
 * Decided by the owner on 2026-10-07: build it, for the free plan and Premium.
 * The reasoning and the shape are in `docs/decisions/search/meaning-search.md`;
 * the index's wire is `lib/vectorize.ts`; what goes into it is decided in the
 * gateway (`apps/mcp/src/search/meaning/`).
 *
 * Everything here is internal. Who may turn it on and off from the app, and
 * whether it is on for everyone by default, are the next change's.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import {
  disableMeaningHandler,
  enableMeaningHandler,
  forgetMeaningIndexHandler,
  meaningRowFor,
  recordMeaningProvisionHandler,
} from "./lib/meaningFns/rows";

/** The row, for the provisioner. Internal: it names an index. */
export const indexForWorkspace = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const row = await meaningRowFor(ctx, args.workspaceId);
    if (row === null) return null;
    return { enabled: row.enabled, status: row.status, indexName: row.indexName };
  },
});

/**
 * Where the gateway writes this workspace's passages, or `null`.
 *
 * Only an index that is on, named, and past provisioning takes writes:
 * `backfilling` does, so a save during the catch-up pass is not lost to it.
 * `workspaceId` comes off the grant in `controlPlane.ts`, never the caller, for
 * `fastSearch.projectionTargetForWorkspace`'s reason.
 */
export const writeTargetForWorkspace = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      indexName: v.string(),
      state: v.union(v.literal("backfilling"), v.literal("ready")),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await meaningRowFor(ctx, args.workspaceId);
    if (row === null || !row.enabled || row.indexName === undefined) return null;
    if (row.status !== "backfilling" && row.status !== "ready") return null;
    return { indexName: row.indexName, state: row.status };
  },
});

export const enable = internalMutation({
  args: { workspaceId: v.id("workspaces"), by: v.optional(v.id("users")) },
  returns: v.object({ scheduled: v.boolean() }),
  handler: (ctx, args) => enableMeaningHandler(ctx, args),
});

export const disable = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ releasing: v.boolean() }),
  handler: (ctx, args) => disableMeaningHandler(ctx, args),
});

export const recordProvisionResult = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    status: v.union(
      v.literal("provisioning"),
      v.literal("backfilling"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    indexName: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    error: v.optional(v.string()),
    notesIndexed: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordMeaningProvisionHandler(ctx, args);
    return null;
  },
});

export const forgetIndex = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await forgetMeaningIndexHandler(ctx, args);
    return null;
  },
});
