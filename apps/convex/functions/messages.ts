/**
 * In-app messages: which ones the caller has answered, on every device.
 *
 * The messages themselves are named in `IN_APP_MESSAGES` (`packages/shared`),
 * and the app's one arbiter decides what is on screen. This file only
 * remembers answers, and only for names on that list whose answer has no
 * other home — so the table holds labels and times, never text.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import {
  IN_APP_MESSAGES,
  MESSAGE_VARIANT_PATTERN,
  isInAppMessageId,
  type InAppMessageSpec,
} from "@context/shared";
import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { requireWorkspaceAccess } from "./lib/workspaceAuth";

/** Far above the rows one person can make; the list is bounded by the registry. */
const READS_LIMIT = 1000;

const readValidator = v.object({
  message: v.string(),
  workspaceId: v.union(v.id("workspaces"), v.null()),
  variant: v.union(v.string(), v.null()),
  seenAt: v.number(),
});

/** Every answer the caller has given; null when signed out. */
export const myMessageReads = query({
  args: {},
  returns: v.union(v.array(readValidator), v.null()),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const rows = await ctx.db
      .query("messageReads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(READS_LIMIT);
    const reads = rows.map((row) => ({
      message: row.message,
      workspaceId: row.workspaceId ?? null,
      variant: row.variant ?? null,
      seenAt: row.seenAt,
    }));
    // The early-beta notice's answers from before this table: still answers.
    if (!reads.some((read) => read.message === "beta-notice")) {
      const legacy = await ctx.db
        .query("betaNoticeReads")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();
      if (legacy !== null) {
        reads.push({ message: "beta-notice", workspaceId: null, variant: null, seenAt: legacy.seenAt });
      }
    }
    return reads;
  },
});

function refuse(message: string): never {
  throw new ConvexError({ code: "INVALID_MESSAGE", message });
}

/**
 * Record that the caller answered `message` (in `workspaceId`, for `variant`).
 * Idempotent: an answer keeps its first time, except for a message that may be
 * asked again, whose time moves forward. No rate limit is needed — the rows one
 * person can hold are bounded by the list, their workspaces and the variants.
 */
export const markMessageSeen = mutation({
  args: {
    message: v.string(),
    workspaceId: v.optional(v.id("workspaces")),
    variant: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    if (!isInAppMessageId(args.message)) refuse("Not an in-app message");
    const spec: InAppMessageSpec = IN_APP_MESSAGES[args.message];
    if (spec.store !== "messageReads") refuse("This message is answered elsewhere");
    if ((spec.scope === "workspace") !== (args.workspaceId !== undefined)) {
      refuse("Wrong scope for this message");
    }
    if (args.variant !== undefined && (spec.variants !== true || !MESSAGE_VARIANT_PATTERN.test(args.variant))) {
      refuse("Not a variant");
    }
    // A workspace the caller is not in answers exactly like one that does not exist.
    if (args.workspaceId !== undefined) await requireWorkspaceAccess(ctx, args.workspaceId, userId);

    const rows = await ctx.db
      .query("messageReads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(READS_LIMIT);
    const row = rows.find(
      (read) =>
        read.message === args.message &&
        read.workspaceId === args.workspaceId &&
        read.variant === args.variant,
    );
    const now = Date.now();
    // A full list is somebody minting variants, not reading messages: the
    // answers already kept still stand, and nothing more is written.
    if (row === undefined && rows.length >= READS_LIMIT) return null;
    if (row === undefined) {
      await ctx.db.insert("messageReads", {
        userId,
        message: args.message,
        ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
        ...(args.variant === undefined ? {} : { variant: args.variant }),
        seenAt: now,
      });
    } else if (spec.askAgainAfterMs !== undefined) {
      await ctx.db.patch(row._id, { seenAt: now });
    }
    return null;
  },
});
