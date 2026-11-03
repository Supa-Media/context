/**
 * Send every person's `reach` to their object again (2026-11-02): each reach row now carries `rowNames`, the names a
 * grant on a row gives (`lib/accessObjects/expected.ts` `rowNamesOf`). A person whose access is decided in their
 * object is never copied into by the backfill (`accessObjects.ts` skips `object`), and reach is sent only when one of
 * its sources changes, so rows copied before the change hold no names until this runs. It queues the same outbox entry
 * a change would (`lib/accessHandOff/flush.ts`), so the push reads reach as Convex holds it then and writes it whole.
 *
 * Run from the `Access reach resend` workflow, whose log is public: it answers counts and a cursor only. `dryRun`
 * counts and queues nothing.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "./lib/rowWatch/mutations";
import { accessHomeOf } from "./lib/accessObjects/home";

/** Workspaces read per page. */
const PAGE = 100;

export const resend = internalMutation({
  args: { dryRun: v.boolean(), cursor: v.optional(v.string()) },
  handler: async (ctx, { dryRun, cursor }) => {
    const page = await ctx.db.query("workspaces").paginate({ cursor: cursor ?? null, numItems: PAGE });
    let people = 0;
    let queued = 0;
    for (const workspace of page.page) {
      if (workspace.kind !== "personal") continue;
      people += 1;
      if ((await accessHomeOf(ctx.db, workspace._id, "person")) === "convex") continue;
      queued += 1;
      if (dryRun) continue;
      await ctx.db.insert("accessObjectOutbox", { workspaceId: workspace._id, tables: ["reach"], at: Date.now() });
      await ctx.scheduler.runAfter(0, internal.functions.accessObjectPush.drain, { workspaceId: workspace._id });
    }
    return { dryRun, people, queued, done: page.isDone, cursor: page.continueCursor };
  },
});
