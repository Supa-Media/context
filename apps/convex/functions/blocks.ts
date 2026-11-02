/**
 * Blocking a person, for what reaches you only — the three functions the app
 * calls. What a block does is `lib/blocks.ts`; why it is per recipient and
 * not global is `docs/decisions/privacy-and-sharing/reporting-and-blocking.md`.
 *
 * ## You block somebody through what they sent you
 *
 * `blockPerson` takes a share or an invitation token, not a user id. A user id
 * is harvestable (members see who invited whom), and a block list that named
 * whoever an id belonged to would turn any harvested id into a handle and a
 * name. Resolving the person from something addressed to the caller means the
 * list only ever names people who already reached them, and it is how the app
 * offers the button anyway: on the @shared row and the invitation card.
 *
 * Every token that does not resolve — never issued, not addressed to the
 * caller, already blocked — is the same `null` and writes nothing.
 *
 * Email proof is not required: blocking only narrows what reaches the caller,
 * and somebody signed in on a phone alone must be able to do it at once.
 */

import { v } from "convex/values";
import { requireAuthId } from "./lib/signedIn";
import { query } from "../_generated/server";
import { mutation } from "./lib/rowWatch/mutations";
import type { Id } from "../_generated/dataModel";
import { MAX_BLOCKS, insertBlock, removeBlock } from "./lib/blocks";
import { handleForUser } from "./lib/identities";
import { resolveReportTarget } from "./lib/reports/target";
import { sharerName } from "./lib/shares/inboxTitle";

export const blockPerson = mutation({
  args: {
    via: v.union(v.literal("share"), v.literal("invitation")),
    /** The share's or the invitation's token, as the caller's own list gave it. */
    token: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const reached = await resolveReportTarget(ctx, userId, { kind: args.via, token: args.token });
    if (reached.personId === null) return null;
    await insertBlock(ctx, userId, reached.personId);
    return null;
  },
});

export const unblockPerson = mutation({
  args: {
    /** As `listBlockedPeople` gave it. A string, so a malformed id is one more no-op. */
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const blockedId = ctx.db.normalizeId("users", args.userId);
    if (blockedId === null) return null;
    await removeBlock(ctx, userId, blockedId);
    return null;
  },
});

/** The people I blocked, newest first: who they are to me, nothing more. */
export const listBlockedPeople = query({
  args: {},
  returns: v.array(
    v.object({
      userId: v.id("users"),
      /** Their handle without the `@`, or `null` for an account with none. */
      handle: v.union(v.string(), v.null()),
      name: v.union(v.string(), v.null()),
      blockedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const rows = await ctx.db
      .query("userBlocks")
      .withIndex("by_blocker", (q) => q.eq("blockerId", userId))
      .order("desc")
      .take(MAX_BLOCKS);
    const people = [];
    for (const row of rows) {
      people.push({
        userId: row.blockedId,
        handle: await handleForUser(ctx, row.blockedId),
        name: await sharerName(ctx, row.blockedId),
        blockedAt: row.createdAt,
      });
    }
    return people;
  },
});
