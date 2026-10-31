/**
 * A deleted workspace's Tex notes, wiped from its Durable Object (decided by
 * the owner, 2026-10-31; `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * The workspace cascade (`account.ts`) schedules this in the transaction that
 * deletes the workspace; it reaches the object through the gateway's door
 * (`lib/texStore.ts`) and is retried with backoff until it lands. Wiping an
 * object that holds nothing is a no-op, so every deleted workspace is wiped.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { consoleTexBuckets } from "./lib/texStore";

/** Tries before it stops and says so in the logs: about a day with the backoff below. */
const MAX_ATTEMPTS = 12;

/** One minute, doubling, at most six hours. */
function backoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** attempt, 6 * 60 * 60 * 1000);
}

export const wipeWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, attempt }) => {
    const buckets = consoleTexBuckets(ctx, workspaceId);
    // A deployment that cannot reach a gateway has no Tex objects either: nothing was ever kept in one.
    if (buckets === null) return null;
    try {
      await buckets(`person:${workspaceId}`).wipe();
      console.log(JSON.stringify({ event: "tex_store_wiped", workspaceId }));
    } catch {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        console.error(JSON.stringify({ event: "tex_store_wipe_failed", workspaceId, attempts: attempt + 1 }));
        return null;
      }
      const delay = backoffMs(attempt);
      await ctx.scheduler.runAfter(delay, internal.functions.texStoreWipe.wipeWorkspace, { workspaceId, attempt: attempt + 1 });
    }
    return null;
  },
});
