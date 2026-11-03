/**
 * Who sees where each Tex turn's time went in a chat's history (Dev,
 * 2026-11-03: "only breakdowns for developers", then "not just admin page, any
 * context-lc editor"): an owner or editor of the pinned context
 * (`PINNED_CONTEXT_SLUG`), the people who build Tex. A member who only reads
 * there does not.
 *
 * It decides what the app draws, never what anyone may read: the `timing`
 * block lives on the person's own reply entries, which the gateway hands them
 * whoever they are. It holds step names and numbers only
 * (`apps/mcp/src/agent/turnTiming.js`).
 */

import { v } from "convex/values";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { query } from "../_generated/server";
import { getAuthUserId } from "./lib/signedIn";
import { getMembership } from "./lib/workspaceAuth";

export const canSeeTurnTiming = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return false;
    const pinned = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", PINNED_CONTEXT_SLUG))
      .unique();
    if (pinned === null) return false;
    const membership = await getMembership(ctx, pinned._id, userId);
    return membership?.role === "owner" || membership?.role === "editor";
  },
});
