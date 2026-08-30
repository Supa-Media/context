/**
 * Where the share-card renderer's wasm lives.
 *
 * Split out of `cardRender.ts` for a hard reason rather than tidiness: that
 * module is `"use node"`, and **a Node module may only define actions** — a
 * mutation or query in one fails the push outright. So the two rows-and-ids
 * functions live here, in the default runtime, and the action calls across.
 *
 * See `cardRender.ts` for why the wasm is in file storage at all.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

/** Where the installed wasm lives. One row, replaced rather than accumulated. */
export const recordWasm = internalMutation({
  args: { storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("renderAssets").first();
    if (existing === null) {
      await ctx.db.insert("renderAssets", {
        kind: "resvgWasm",
        storageId: args.storageId,
        updatedAt: Date.now(),
      });
      return null;
    }
    // The previous object is deleted, not orphaned: file storage is ours, not
    // the customer's, and an unreferenced 2.4 MB blob per deploy is a leak.
    const previous = existing.storageId;
    await ctx.db.patch(existing._id, {
      storageId: args.storageId,
      updatedAt: Date.now(),
    });
    if (previous !== args.storageId) await ctx.storage.delete(previous);
    return null;
  },
});

/** The installed wasm's id, or `null` if nobody has installed it. */
export const wasmAsset = internalQuery({
  args: {},
  returns: v.union(v.null(), v.id("_storage")),
  handler: async (ctx) => {
    const row = await ctx.db.query("renderAssets").first();
    return row?.storageId ?? null;
  },
});

/**
 * Collect the pieces of an incoming wasm, and hand them back once they are all
 * here.
 *
 * The staging rows are deleted as soon as they are assembled, so a completed
 * install leaves nothing behind. An *abandoned* install does leave rows — the
 * next one clears them, because it starts at index 0 and that is the signal
 * that a fresh upload has begun. A partial upload is therefore recoverable by
 * running the script again, which is the only recovery anyone would try.
 */
export const appendChunk = internalMutation({
  args: { chunk: v.bytes(), index: v.number(), total: v.number() },
  returns: v.union(v.null(), v.array(v.bytes())),
  handler: async (ctx, args) => {
    if (args.index === 0) {
      for (const stale of await ctx.db.query("renderAssetChunks").collect()) {
        await ctx.db.delete(stale._id);
      }
    }

    await ctx.db.insert("renderAssetChunks", {
      index: args.index,
      total: args.total,
      chunk: args.chunk,
    });

    const rows = await ctx.db.query("renderAssetChunks").collect();
    if (rows.length < args.total) return null;

    // Ordered explicitly. Insertion order is not a guarantee, and a wasm
    // assembled out of order is a file that deploys and throws.
    rows.sort((a, b) => a.index - b.index);
    const parts = rows.map((row) => row.chunk);
    for (const row of rows) await ctx.db.delete(row._id);
    return parts;
  },
});
