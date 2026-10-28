/**
 * Spelling in the note editor, kept on the account: on or off, which
 * dictionary, and the words the person taught it (Dev2, 2026-10-27).
 *
 * The app keeps a copy on each device so the first note opened is underlined
 * correctly before this answers; this is the copy that makes a word added on
 * the phone stop being red on the Mac. Every function names no user: the
 * caller is the only key, so a read or write can reach nobody else's row.
 */

import { v } from "convex/values";
import { getAuthUserId, requireAuthId } from "./lib/signedIn";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import { consumeRateLimit } from "./lib/rateLimit";

const language = v.union(v.literal("en-US"), v.literal("en-GB"));
type Language = "en-US" | "en-GB";

/** More words than anybody adds by hand; a ceiling on a client stuck adding. */
export const MAX_WORDS = 5000;
/** The longest word kept. The longest English dictionary word is 45 letters. */
export const MAX_WORD_LENGTH = 64;

/**
 * A word as somebody would add it: letters, with apostrophes and hyphens
 * inside. Anything else — a space, a digit, markup, a control character — is
 * refused, so the list cannot be used to store a sentence.
 */
const WORD = /^[\p{L}\p{M}](?:[\p{L}\p{M}'’-]*[\p{L}\p{M}])?$/u;

/** Generous for somebody clicking Add down a page of names; small for a loop. */
const WRITES_PER_HOUR = 600;
const SPELLING_WINDOW_MS = 60 * 60 * 1000;

const DEFAULTS = { enabled: true, language: "en-US" as Language, words: [] as string[] };

/** The caller's settings, or null (signed out, or never changed anything). */
export const mySpelling = query({
  args: {},
  returns: v.union(
    v.object({ enabled: v.boolean(), language, words: v.array(v.string()), updatedAt: v.number() }),
    v.null(),
  ),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const row = await ctx.db
      .query("spellingPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row === null) return null;
    return { enabled: row.enabled, language: row.language, words: row.words, updatedAt: row.updatedAt };
  },
});

/** Turn the underlines on or off, or change the dictionary. Either or both. */
export const setMySpelling = mutation({
  args: { enabled: v.optional(v.boolean()), language: v.optional(language) },
  returns: v.number(),
  handler: async (ctx, args) => {
    return await writeRow(ctx, (row) => ({
      ...row,
      ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
      ...(args.language === undefined ? {} : { language: args.language }),
    }));
  },
});

/** Add one word to the caller's dictionary. Adding a word already there changes nothing. */
export const learnSpellingWord = mutation({
  args: { word: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const word = args.word.trim().normalize("NFC");
    if (word.length > MAX_WORD_LENGTH || !WORD.test(word)) {
      throw new Error("That is not a word the dictionary can keep.");
    }
    return await writeRow(ctx, (row) => {
      const lowered = word.toLowerCase();
      if (row.words.some((known) => known.toLowerCase() === lowered)) return row;
      if (row.words.length >= MAX_WORDS) throw new Error("Your dictionary is full. Remove a word in Settings first.");
      return { ...row, words: [...row.words, word] };
    });
  },
});

/** Take one word out of the caller's dictionary, in any case. */
export const forgetSpellingWord = mutation({
  args: { word: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const lowered = args.word.trim().normalize("NFC").toLowerCase();
    return await writeRow(ctx, (row) => ({
      ...row,
      words: row.words.filter((known) => known.toLowerCase() !== lowered),
    }));
  },
});

type Settings = Pick<Doc<"spellingPreferences">, "enabled" | "language" | "words">;

/** Read the caller's row (or the defaults), change it, write it back. */
async function writeRow(ctx: MutationCtx, change: (row: Settings) => Settings): Promise<number> {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  await consumeRateLimit(ctx, {
    key: `spelling:${userId}`,
    limit: WRITES_PER_HOUR,
    windowMs: SPELLING_WINDOW_MS,
  });
  const row = await ctx.db
    .query("spellingPreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const current: Settings = row === null ? DEFAULTS : { enabled: row.enabled, language: row.language, words: row.words };
  const next = change(current);
  const updatedAt = Date.now();
  if (row === null) {
    await ctx.db.insert("spellingPreferences", { userId, ...next, updatedAt });
  } else {
    await ctx.db.patch(row._id, { ...next, updatedAt });
  }
  return updatedAt;
}
