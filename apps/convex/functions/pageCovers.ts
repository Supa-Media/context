/**
 * A page's cover, kept for its link's card (`lib/shares/pageCover.ts`). The
 * gateway reports the cover it drew (`lib/gatewayRoutes/pageCover.ts`); the
 * bytes go to the owner's bucket and the row keeps the leaf.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { livePageRow } from "./lib/shares/pageCover";

/** The page a cover is for: its note id (or path, on a row from before ids), or `null` when there is no live page there. INTERNAL. */
export const coverTarget = internalQuery({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.union(v.null(), v.object({ key: v.string() })),
  handler: async (ctx, { workspaceId, path }) => {
    const row = await livePageRow(ctx.db, workspaceId, path);
    return row === null ? null : { key: row.noteId ?? row.path };
  },
});

/** Keep the leaf on the page's row, if it is still a live page. INTERNAL. */
export const recordCover = internalMutation({
  args: { workspaceId: v.id("workspaces"), path: v.string(), leaf: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, path, leaf }) => {
    const row = await livePageRow(ctx.db, workspaceId, path);
    if (row === null) return false;
    await ctx.db.patch(row._id, { pageCover: leaf });
    return true;
  },
});
