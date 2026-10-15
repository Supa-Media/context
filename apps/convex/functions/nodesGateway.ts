/**
 * Reads of the Convex tree kept apart from `nodes.ts`, which owns the rows
 * and their writes: the gateway's (`lib/nodes/gatewayManifest.ts`,
 * `lib/nodes/gatewayNames.ts`) and the names a write asks about
 * (`lib/nodes/treeTaken.ts`).
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { readClearanceArgs, readClearanceHandler, readClearanceReturns } from "./lib/nodes/gatewayManifest";
import { treeServesNow } from "./lib/nodes/listing";
import { TAKEN_PATHS, treeTaken } from "./lib/nodes/treeTaken";

/** The workspace and tier a gateway-borne token reads at, or null. INTERNAL. */
export const readClearance = internalQuery({
  args: readClearanceArgs,
  returns: readClearanceReturns,
  handler: readClearanceHandler,
});

/**
 * Which of `paths` the tree draws a file or a folder at, through pending
 * moves, or `null` while the tree does not serve the workspace (its first
 * copy has not finished). Unfiltered names: the caller decides what to say.
 * INTERNAL.
 */
export const taken = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.union(v.null(), v.object({ files: v.array(v.string()), folders: v.array(v.string()) })),
  handler: async (ctx, { workspaceId, paths }) => {
    if (paths.length > TAKEN_PATHS) throw new Error("too many paths in one ask");
    if (!(await treeServesNow(ctx.db, workspaceId))) return null;
    return await treeTaken(ctx.db, workspaceId, paths);
  },
});
