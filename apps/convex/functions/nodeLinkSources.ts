/**
 * Which notes hold links of their own, from the tree's link facts (`nodeLinks`):
 * what a move's link rewrite asks about the notes it moved, whose relative
 * links change with them (`lib/fileOps/references.ts`). A moved note with no
 * links is not read. Paths only, unfiltered; the caller judges them with
 * `canSee`. INTERNAL.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

/** Paths one ask may name: the console asks in batches of a thousand. */
const LINKING_PATHS = 2_000;

export const linking = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { workspaceId, paths }) => {
    if (paths.length > LINKING_PATHS) throw new Error("nodes.linking_too_many");
    const found: string[] = [];
    for (const path of new Set(paths)) {
      const link = await ctx.db
        .query("nodeLinks")
        .withIndex("by_workspace_source", (q) => q.eq("workspaceId", workspaceId).eq("source", path))
        .first();
      if (link !== null) found.push(path);
    }
    return found;
  },
});
