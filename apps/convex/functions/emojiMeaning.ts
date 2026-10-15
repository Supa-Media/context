/**
 * The emoji fingerprints the icon picker's suggestion searches by meaning.
 *
 * One build per `emojiMeaningSet()`, shared by every workspace: they are made
 * from our own descriptions of the standard emoji, never from anybody's notes.
 * The first suggestion a deployment answers after the descriptions change
 * finds no ready build, starts filling one here and is answered by Clef
 * meanwhile (`lib/emojiMeaningLookup.ts`). A fill is about sixty embedding
 * calls, so it finishes in well under a minute; one that dies is claimed
 * again once it has been quiet for `FILL_STALE_MS` and starts over, skipping
 * on write the rows it already has.
 */

import { v } from "convex/values";
import { emojiMeaningSet, emojiMeaningTexts } from "@context/shared/src/emojiMeaning";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { emojiEmbedder } from "./lib/emojiMeaningLookup";

/** A fill quiet this long is taken to have died and may be claimed again. */
export const FILL_STALE_MS = 10 * 60 * 1000;

/** Texts per embedding call and rows per write. */
const FILL_BATCH = 32;

/** Embedding calls in flight at once while filling. */
const FILL_PARALLEL = 4;

/** Rows of an old build deleted per mutation. */
const DROP_BATCH = 200;

/** `"ready"`, `"filling"`, or `null` for a build nobody has started. */
export const setState = internalQuery({
  args: { set: v.string() },
  returns: v.union(v.literal("ready"), v.literal("filling"), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("emojiMeaningSets")
      .withIndex("by_set", (q) => q.eq("set", args.set))
      .unique();
    return row?.state ?? null;
  },
});

/** Start filling `set` unless it is ready or a live fill holds it. True when this caller should fill. */
export const claimFill = internalMutation({
  args: { set: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db
      .query("emojiMeaningSets")
      .withIndex("by_set", (q) => q.eq("set", args.set))
      .unique();
    if (row === null) {
      await ctx.db.insert("emojiMeaningSets", { set: args.set, state: "filling", startedAt: now, filled: 0 });
      return true;
    }
    if (row.state === "ready" || now - row.startedAt < FILL_STALE_MS) return false;
    await ctx.db.patch(row._id, { startedAt: now });
    return true;
  },
});

/** Write a batch of fingerprints, skipping any already there, and keep the claim alive. */
export const insertBatch = internalMutation({
  args: { set: v.string(), rows: v.array(v.object({ char: v.string(), vector: v.array(v.float64()) })) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.db
      .query("emojiMeaningSets")
      .withIndex("by_set", (q) => q.eq("set", args.set))
      .unique();
    if (claim === null || claim.state !== "filling") return null;
    let added = 0;
    for (const row of args.rows) {
      const present = await ctx.db
        .query("emojiMeanings")
        .withIndex("by_set_char", (q) => q.eq("set", args.set).eq("char", row.char))
        .first();
      if (present !== null) continue;
      await ctx.db.insert("emojiMeanings", { set: args.set, char: row.char, vector: row.vector });
      added += 1;
    }
    await ctx.db.patch(claim._id, { startedAt: Date.now(), filled: claim.filled + added });
    return null;
  },
});

/** Mark `set` ready when every emoji has its row, and start dropping older builds. */
export const markReady = internalMutation({
  args: { set: v.string(), expected: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const claim = await ctx.db
      .query("emojiMeaningSets")
      .withIndex("by_set", (q) => q.eq("set", args.set))
      .unique();
    if (claim === null || claim.filled < args.expected) return false;
    await ctx.db.patch(claim._id, { state: "ready" });
    await ctx.scheduler.runAfter(0, internal.functions.emojiMeaning.dropOld, { keep: args.set });
    return true;
  },
});

/** Delete the rows of every build but `keep`, a batch at a time. */
export const dropOld = internalMutation({
  args: { keep: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const old = (await ctx.db.query("emojiMeaningSets").collect()).filter((row) => row.set !== args.keep);
    const first = old[0];
    if (first === undefined) return null;
    const rows = await ctx.db
      .query("emojiMeanings")
      .withIndex("by_set_char", (q) => q.eq("set", first.set))
      .take(DROP_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length < DROP_BATCH) await ctx.db.delete(first._id);
    await ctx.scheduler.runAfter(0, internal.functions.emojiMeaning.dropOld, { keep: args.keep });
    return null;
  },
});

/** The emoji on one fingerprint row, for a search's best match. */
export const charOf = internalQuery({
  args: { id: v.id("emojiMeanings") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => (await ctx.db.get(args.id as Id<"emojiMeanings">))?.char ?? null,
});

/**
 * Embed every emoji's text into `set` and mark it ready. Does nothing for a
 * set this deployment no longer builds, or with no inference Worker.
 */
export const fill = internalAction({
  args: { set: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.set !== emojiMeaningSet()) return null;
    const embed = await emojiEmbedder("emoji:fill");
    if (embed === null) return null;
    try {
      const all = emojiMeaningTexts();
      const batches: (typeof all)[] = [];
      for (let at = 0; at < all.length; at += FILL_BATCH) batches.push(all.slice(at, at + FILL_BATCH));
      for (let at = 0; at < batches.length; at += FILL_PARALLEL) {
        await Promise.all(
          batches.slice(at, at + FILL_PARALLEL).map(async (batch) => {
            const vectors = await embed(batch.map(({ text }) => text));
            await ctx.runMutation(internal.functions.emojiMeaning.insertBatch, {
              set: args.set,
              rows: batch.map(({ char }, index) => ({ char, vector: vectors[index]! })),
            });
          }),
        );
      }
      await ctx.runMutation(internal.functions.emojiMeaning.markReady, { set: args.set, expected: all.length });
    } catch {
      // The Worker said no or is not deployed yet. The claim goes quiet and
      // the next suggestion after `FILL_STALE_MS` starts again; Clef answers
      // until then. Nothing about the texts is logged.
      console.log(JSON.stringify({ event: "emoji_meaning_fill_failed", set: args.set }));
    }
    return null;
  },
});
