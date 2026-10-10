import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * SAVED MODEL KEYS: DELETED, AND NOTHING READS THEM ANY MORE.
 *
 * People could once save their own Anthropic or OpenAI key for the assistant
 * to spend ("bring your own key"). The owner removed that on 2026-10-10: the
 * keys are deleted and the assistant runs only on the built-in model
 * (`builtinModel.ts`, and `apps/mcp/src/agent/turn.js` on the gateway's side).
 * The Settings page went first (#1465); the functions that saved, listed,
 * disconnected and opened a key, and the `/gateway/provider` route the gateway
 * fetched one through, went with this file's rewrite.
 *
 * What is left is the one-off that empties the table. The table itself stays
 * in the schema only so a deploy does not fail on rows that still exist; it can
 * be dropped once production has run this to the end.
 */

/** Rows deleted per call. Small enough to stay far inside a mutation's limits. */
const DEFAULT_BATCH = 200;
const MAX_BATCH = 500;

function batchSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_BATCH;
  return Math.min(MAX_BATCH, Math.max(1, Math.floor(limit)));
}

/**
 * Delete up to `limit` saved keys, and schedule the next batch while any are
 * left, so one call empties `providerCredentials` on a deployment:
 *
 *     npx convex run --prod functions/providers:deleteSavedKeys '{}'
 *
 * Touches that table and nothing else: no audit row per key (the people who
 * saved them did not act, and a row naming each workspace would be a list of
 * who had a key), no workspace, no grant. It logs counts only — never a key, a
 * fingerprint, or which workspace a row belonged to.
 *
 * Idempotent: run again, or run twice at once, and it deletes what is still
 * there and stops.
 */
export const deleteSavedKeys = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), more: v.boolean() }),
  handler: async (ctx, args) => {
    const size = batchSize(args.limit);
    // One more than the batch, so "is there more?" needs no second query.
    const rows = await ctx.db.query("providerCredentials").take(size + 1);
    const batch = rows.slice(0, size);
    for (const row of batch) await ctx.db.delete(row._id);
    const more = rows.length > size;
    if (more) {
      await ctx.scheduler.runAfter(0, internal.functions.providers.deleteSavedKeys, { limit: size });
    }
    console.log(JSON.stringify({ event: "provider_keys_deleted", deleted: batch.length, more }));
    return { deleted: batch.length, more };
  },
});
