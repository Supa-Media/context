/**
 * Tex's self-review: what a finished conversation's scores may carry, and
 * where they go (`docs/decisions/texting-assistant/self-review.md`).
 *
 * The gateway scores a conversation once it ends (`apps/mcp/src/agent/
 * selfReview.js`) and sends the scores here with the texting grant's own
 * token. Who the conversation was with decides the rest, here and never in
 * the gateway:
 *
 *   - **Everybody in it is staff** (`ADMIN_EMAILS`, verified, `lib/admin.ts`)
 *     **or said yes** in Settings → Feedback (`texReviewSharing`): the tier is
 *     `full`, and the review is a note in the pinned context the team reads,
 *     with what they expected, how Tex should improve, and the conversation.
 *   - **Anybody else**: `scores`. The numbers become an anonymous row and a
 *     line in the day's scores note, and the gateway is told not to send any
 *     words. Words sent anyway are dropped unread.
 *
 * A group chat is everybody in it, read from its grant (`texGroup`), so one
 * person who has not said yes keeps the whole chat's words out.
 */

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "../_generated/server";
import { userIsStaff } from "./lib/admin";
import { usernameOf } from "./lib/adminFns/people";
import { TEXTS_CLIENT_ID } from "./lib/feedback/agentReport";
import { reviewFolder } from "./lib/feedback/texReviewNote";
import { folderJobsOf } from "./lib/nodes/folderJobs";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { guestNamesIn } from "./lib/pinnedReaders";
import { consumeRateLimit } from "./lib/rateLimit";
import { TEXTS_GROUP_CLIENT_ID } from "./textGroups";

/** A busy hour of texting ends a few conversations; this only stops a loop. */
const REVIEWS_PER_HOUR = 30;
/** One rate-limit window, for the review filing and the switch alike. */
const REVIEW_WINDOW_MS = 60 * 60 * 1000;
/** A day's scores note lists at most this many. */
export const MAX_SCORES_PER_DAY = 500;
/** Scores rows are kept this long, then swept a few at a time as new ones arrive. */
export const SCORES_KEPT_MS = 90 * 24 * REVIEW_WINDOW_MS;
const SWEEP_PER_WRITE = 20;
const SWITCH_WRITES_PER_HOUR = 30;

const scoreFields = {
  goal: v.number(),
  independence: v.number(),
  turns: v.number(),
  friendly: v.number(),
  calm: v.number(),
};

/**
 * Everything one review needs decided, from the grant that sent it: whether
 * it may keep words, who was in the conversation, and the pinned context's
 * folder, or null for a grant that is not one of Tex's.
 */
export const reviewSetup = internalQuery({
  args: { grantId: v.id("oauthGrants") },
  returns: v.union(
    v.null(),
    v.object({
      tier: v.union(v.literal("full"), v.literal("scores")),
      kind: v.union(v.literal("one"), v.literal("group")),
      userId: v.id("users"),
      people: v.array(v.string()),
      destination: v.union(
        v.null(),
        v.object({ workspaceId: v.id("workspaces"), folder: v.string(), pinReaders: v.array(v.string()) }),
      ),
    }),
  ),
  handler: async (ctx, { grantId }) => {
    const grant = await ctx.db.get(grantId);
    if (grant === null || grant.status !== "active") return null;
    let kind: "one" | "group";
    let everyone: Id<"users">[];
    if (grant.clientId === TEXTS_CLIENT_ID) {
      kind = "one";
      everyone = [grant.userId];
    } else if (grant.clientId === TEXTS_GROUP_CLIENT_ID && grant.texGroup !== undefined) {
      kind = "group";
      everyone = [grant.userId, ...grant.texGroup.coViewerIds];
    } else {
      return null;
    }
    let full = true;
    const people: string[] = [];
    for (const userId of [...new Set(everyone)]) {
      if (full && !(await userIsStaff(ctx, userId)) && !(await sharesReviews(ctx, userId))) full = false;
      const handle = await usernameOf(ctx, userId);
      if (handle !== null) people.push(handle);
    }
    const pinned = await pinnedContextWorkspace(ctx);
    const destination =
      pinned === null
        ? null
        : {
            workspaceId: pinned._id,
            folder: reviewFolder((await folderJobsOf(ctx.db, pinned._id)).jobs.areas ?? null),
            pinReaders: await guestNamesIn(ctx, pinned._id),
          };
    // The handles go only where the words go: a scores-only review names nobody.
    return { tier: full ? ("full" as const) : ("scores" as const), kind, userId: grant.userId, people: full ? people : [], destination };
  },
});

async function sharesReviews(ctx: Pick<QueryCtx, "db">, userId: Id<"users">): Promise<boolean> {
  const row = await ctx.db
    .query("texReviewSharing")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return row !== null;
}

/**
 * One review's numbers, kept without anybody's name, and the day's rows to
 * write the scores note from. Counted against the person whose grant sent it,
 * so a loop cannot fill the table; the row itself does not name them.
 */
export const recordScores = internalMutation({
  args: {
    userId: v.id("users"),
    kind: v.union(v.literal("one"), v.literal("group")),
    reason: v.string(),
    now: v.number(),
    ...scoreFields,
  },
  returns: v.array(v.object({ at: v.number(), kind: v.union(v.literal("one"), v.literal("group")), reason: v.string(), ...scoreFields })),
  handler: async (ctx, { userId, now, ...row }) => {
    await consumeRateLimit(ctx, { key: `tex.review:${userId}`, limit: REVIEWS_PER_HOUR, windowMs: REVIEW_WINDOW_MS });
    const day = new Date(now).toISOString().slice(0, 10);
    await ctx.db.insert("texReviewScores", { day, at: now, ...row });
    const old = await ctx.db
      .query("texReviewScores")
      .withIndex("by_at", (q) => q.lt("at", now - SCORES_KEPT_MS))
      .take(SWEEP_PER_WRITE);
    for (const stale of old) await ctx.db.delete(stale._id);
    const rows = await ctx.db
      .query("texReviewScores")
      .withIndex("by_day", (q) => q.eq("day", day))
      .take(MAX_SCORES_PER_DAY);
    return rows
      .sort((a, b) => a.at - b.at)
      .map(({ at, kind, reason, goal, independence, turns, friendly, calm }) => ({ at, kind, reason, goal, independence, turns, friendly, calm }));
  },
});

/** Whether the caller said yes to sharing their finished conversations with Tex; null signed out. */
export const myTexReviewSharing = query({
  args: {},
  returns: v.union(v.boolean(), v.null()),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    return await sharesReviews(ctx, userId);
  },
});

/** Say yes or no. No deletes the yes; nothing already sent is taken back. */
export const setMyTexReviewSharing = mutation({
  args: { share: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, { share }) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await consumeRateLimit(ctx, { key: `tex.review.sharing:${userId}`, limit: SWITCH_WRITES_PER_HOUR, windowMs: REVIEW_WINDOW_MS });
    const rows = await ctx.db
      .query("texReviewSharing")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    if (!share) {
      for (const row of rows) await ctx.db.delete(row._id);
      return false;
    }
    if (rows.length === 0) await ctx.db.insert("texReviewSharing", { userId, sharedAt: Date.now() });
    return true;
  },
});
