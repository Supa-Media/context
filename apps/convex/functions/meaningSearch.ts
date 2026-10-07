/**
 * Search by meaning, per workspace: the row that says whether it is on, and
 * the internal steps that set its index up and tear it down.
 *
 * Decided by the owner on 2026-10-07: build it, for the free plan and Premium.
 * The reasoning and the shape are in `docs/decisions/search/meaning-search.md`;
 * the index's wire is `lib/vectorize.ts`; what goes into it is decided in the
 * gateway (`apps/mcp/src/search/meaning/`).
 *
 * On for everyone (the owner's call, 2026-10-07): the sweep turns it on for
 * every workspace with storage (`lib/meaningFns/rollout.ts`), and the owner's
 * switch (`status`, `set`) is the only public surface; their off sticks.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { rolloutMeaningStep } from "./lib/meaningFns/rollout";
import { meaningStatusHandler, setMeaningSearchHandler } from "./lib/meaningFns/settings";
import {
  disableMeaningHandler,
  enableMeaningHandler,
  forgetMeaningIndexHandler,
  meaningRowFor,
  recordMeaningProgressHandler,
  recordMeaningProvisionHandler,
  sweepMeaningHandler,
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
      // When the index was turned on, for the catch-up pass: a new index after
      // an off and an on is empty, and its map in the bucket must not say otherwise.
      generation: v.string(),
      state: v.union(v.literal("backfilling"), v.literal("ready")),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await meaningRowFor(ctx, args.workspaceId);
    if (row === null || !row.enabled || row.indexName === undefined) return null;
    if (row.status !== "backfilling" && row.status !== "ready") return null;
    return { indexName: row.indexName, generation: String(row.enabledAt), state: row.status };
  },
});

export const enable = internalMutation({
  args: { workspaceId: v.id("workspaces"), by: v.optional(v.id("users")) },
  returns: v.object({ scheduled: v.boolean() }),
  handler: (ctx, args) => enableMeaningHandler(ctx, args),
});

const meaningStatusValidator = v.object({
  state: v.union(
    v.literal("on"),
    v.literal("preparing"),
    v.literal("waiting"),
    v.literal("failed"),
    v.literal("off"),
  ),
  canChange: v.boolean(),
  // Owner only: a census of notes, private ones included.
  notesIndexed: v.optional(v.number()),
  notesPending: v.optional(v.number()),
});

/** What the Settings card shows. Any member may read it; the counts are the owner's. */
export const status = query({
  args: { workspaceId: v.id("workspaces") },
  returns: meaningStatusValidator,
  handler: (ctx, args) => meaningStatusHandler(ctx, args),
});

/** The owner's switch. Off deletes the index and sticks; on builds it again. */
export const set = mutation({
  args: { workspaceId: v.id("workspaces"), on: v.boolean() },
  returns: meaningStatusValidator,
  handler: (ctx, args) => setMeaningSearchHandler(ctx, args),
});

export const disable = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    // See `MeaningOffReason`. Absent is a workspace being deleted.
    reason: v.optional(v.union(v.literal("owner"), v.literal("storage"), v.literal("workspace"))),
  },
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

export const recordProgress = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    notesIndexed: v.number(),
    notesPending: v.number(),
    ready: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordMeaningProgressHandler(ctx, args);
    return null;
  },
});

export const sweep = internalMutation({
  args: {},
  returns: v.object({ started: v.number() }),
  handler: async (ctx) => {
    const { started } = await sweepMeaningHandler(ctx);
    return { started: started + (await rolloutMeaningStep(ctx)) };
  },
});
