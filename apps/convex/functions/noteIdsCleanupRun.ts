/**
 * The old-copy cleanup's scheduled pages (`lib/cleanup/pass.ts`): the only
 * place the cleanup reaches the gateway's mover or a bucket's credential.
 *
 * The public staff functions in `noteIdsCleanup.ts` never import this module;
 * they schedule `runCount` / `runDelete` by name, as the copy pass does. Each
 * page checks the run is current and, for a Delete, that the gate still
 * passes, before any bucket is asked for anything.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { productionDeps } from "./lib/noteIds/deps";
import { runCountChain, runDeleteChain } from "./lib/cleanup/pass";

/** One page of the Count. */
export const runCount = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.number(),
    phase: v.union(v.literal("bucket"), v.literal("rows")),
    cursor: v.optional(v.string()),
    toDelete: v.number(),
    unclaimed: v.number(),
    readingPaths: v.number(),
    streak: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await runCountChain(ctx, args, productionDeps().cleanup);
    return null;
  },
});

/** One page of the Delete. */
export const runDelete = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    runId: v.number(),
    cursor: v.optional(v.string()),
    streak: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await runDeleteChain(ctx, args, productionDeps().cleanup);
    return null;
  },
});
