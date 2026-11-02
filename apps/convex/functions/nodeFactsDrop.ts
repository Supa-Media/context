/**
 * The control plane stops keeping notes' facts for a workspace whose notes live in its object (decided by the
 * owner, 2026-11-02; `docs/decisions/storage-and-credentials/facts-in-objects.md`). The object holds the text and
 * reads its facts from it; every reader asks the object first, and `/gateway/tree/facts` reads the object too, so
 * the control plane's copy (`nodes.props`, `parsed`, `sealed`, `chaosNote`; `nodeLinks`; `nodeFactState`) is left
 * unread there. A facts pass that finds the workspace's home is `object` drops that copy, a page at a time, instead
 * of filling it (`lib/nodes/factFill.ts`). Nothing here is the only copy of anything: should the workspace's home
 * ever go back to `dual` or `bucket`, its state row is gone and the next pass walks every note again. Each page
 * schedules the next, so a large workspace is dropped over several transactions. INTERNAL.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "./lib/rowWatch/mutations";

/** Rows one drop pass changes: link rows deleted, then note rows cleared. */
export const DROP_PAGE = 200;

export const drop = internalMutation({
  args: { workspaceId: v.id("workspaces"), cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ more: v.boolean(), cursor: v.union(v.string(), v.null()), links: v.number(), notes: v.number() }),
  handler: async (ctx, { workspaceId, cursor }) => {
    // A first call (every tree change starts one) for a workspace already dropped, or never filled, has nothing to
    // do: the fill's state row is the last thing a drop removes, and the only thing that writes facts.
    if (cursor === undefined && (await ctx.db.query("nodeFactState").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).first()) === null) {
      return { more: false, cursor: null, links: 0, notes: 0 };
    }
    // Links first: one index, no cursor needed, since every row read is deleted.
    const links = await ctx.db
      .query("nodeLinks")
      .withIndex("by_workspace_source", (q) => q.eq("workspaceId", workspaceId))
      .take(DROP_PAGE);
    for (const link of links) await ctx.db.delete(link._id);
    if (links.length === DROP_PAGE) {
      await ctx.scheduler.runAfter(0, internal.functions.nodeFactsDrop.drop, { workspaceId, cursor: cursor ?? null });
      return { more: true, cursor: cursor ?? null, links: links.length, notes: 0 };
    }

    const page = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
      .paginate({ cursor: cursor ?? null, numItems: DROP_PAGE });
    let notes = 0;
    for (const row of page.page) {
      if (row.parsed === undefined && row.props === undefined && row.sealed === undefined && row.chaosNote === undefined) continue;
      await ctx.db.patch(row._id, { parsed: undefined, props: undefined, sealed: undefined, chaosNote: undefined });
      notes += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.functions.nodeFactsDrop.drop, { workspaceId, cursor: page.continueCursor });
      return { more: true, cursor: page.continueCursor, links: links.length, notes };
    }

    // Last: the fill's own state, so a home that goes back starts from a whole walk.
    for (const state of await ctx.db.query("nodeFactState").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()) {
      await ctx.db.delete(state._id);
    }
    return { more: false, cursor: null, links: links.length, notes };
  },
});
