/**
 * GOOGLE PUSH: notifications make a connection due sooner; the forward sync
 * loop does everything else.
 *
 * Polling stays exactly as it was (`googleSync.ts`), as the reconciliation
 * every push integration needs underneath it: a dropped notification, an
 * expired watch or a topic nobody set up is only ever noticed by something
 * that polls. What push adds is latency — a new message is fetched within
 * seconds instead of at the next interval — and it adds it without a second
 * way into anybody's bucket. A notification's content is never read for mail,
 * never written anywhere, and cannot name a workspace; it names a mailbox, a
 * channel or a subscription that a pass registered, and the only thing it can
 * do is mark that connection's product pending (`lib/googlePush/pending.ts`).
 *
 * The argument is in `docs/decisions/communications/google-push.md`.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import type { Doc } from "../_generated/dataModel";
import { markPushPending, type PushProduct } from "./lib/googlePush/pending";
import { wakeMailRoutines } from "./lib/routines/wake";
import { googlePushValidator } from "./lib/schema/googlePush";

const productValidator = v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"));

/** Bounded, like every lookup a stranger's request can start. */
const MAX_ROWS_PER_NOTIFICATION = 20;

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/**
 * A Gmail or Chat notification from our Pub/Sub subscription, already
 * authenticated by the route. Unknown names are answered the same as known
 * ones: the route acknowledges either way, so Pub/Sub does not retry a
 * mailbox nobody here watches any more.
 */
export const pokeFromPubsub = internalMutation({
  args: {
    gmailAddress: v.optional(v.string()),
    chatSubscription: v.optional(v.string()),
    /** A subscription lifecycle event (expiring, expired, suspended): renew it on the next pass. */
    chatLifecycle: v.optional(v.boolean()),
  },
  returns: v.object({ poked: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    let rows: Doc<"googleConnections">[] = [];
    let product: PushProduct;
    if (args.gmailAddress !== undefined) {
      product = "gmail";
      const address = args.gmailAddress.trim().toLowerCase();
      rows = await ctx.db
        .query("googleConnections")
        .withIndex("by_push_gmail_address", (q) => q.eq("push.gmail.address", address))
        .take(MAX_ROWS_PER_NOTIFICATION);
    } else if (args.chatSubscription !== undefined) {
      product = "chat";
      const name = args.chatSubscription;
      rows = await ctx.db
        .query("googleConnections")
        .withIndex("by_push_chat_subscription", (q) => q.eq("push.chat.subscriptionName", name))
        .take(MAX_ROWS_PER_NOTIFICATION);
    } else {
      return { poked: 0 };
    }

    let poked = 0;
    for (const row of rows) {
      if (row.disconnectedAt !== undefined) continue;
      if (product === "chat" && args.chatLifecycle === true && row.push?.chat !== undefined) {
        // Due for renewal now: the next chat pass re-runs `ensureGooglePush`
        // against an expiry it no longer trusts.
        await ctx.db.patch(row._id, { push: { ...row.push, chat: { ...row.push.chat, expiresAt: 0 } } });
        row.push = { ...row.push, chat: { ...row.push.chat, expiresAt: 0 } };
      }
      await markPushPending(ctx, row, product, now);
      // New mail in a mailbox shared with a group chat: that chat's mail routines look soon.
      if (product === "gmail") await wakeMailRoutines(ctx, row, now);
      poked += 1;
    }
    return { poked };
  },
});

/**
 * A Calendar notification. The channel id finds the row, and the token Google
 * echoes back proves the channel is one we opened: it is compared against the
 * SHA-256 stored when the channel was registered. "No such channel" and "wrong
 * token" are one answer.
 */
export const acceptCalendarNotification = internalMutation({
  args: { channelId: v.string(), tokenHash: v.string(), resourceState: v.string() },
  returns: v.object({ accepted: v.boolean() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("googleConnections")
      .withIndex("by_push_calendar_channel", (q) => q.eq("push.calendar.channelId", args.channelId))
      .take(2);
    const row = rows.length === 1 ? rows[0]! : null;
    const stored = row?.push?.calendar?.tokenHash;
    if (row === null || stored === undefined || !constantTimeEquals(stored, args.tokenHash)) {
      return { accepted: false };
    }
    if (row.disconnectedAt !== undefined) return { accepted: false };
    // `sync` is the handshake Google sends when a channel opens; there is
    // nothing new to fetch yet.
    if (args.resourceState !== "sync") await markPushPending(ctx, row, "calendar", Date.now());
    return { accepted: true };
  },
});

/** What `ensureGooglePush` needs to decide whether to (re)register, and nothing secret. */
export const pushState = internalQuery({
  args: { connectionId: v.id("googleConnections") },
  returns: v.union(
    v.null(),
    v.object({
      address: v.string(),
      products: v.array(productValidator),
      gmailFolders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
      push: googlePushValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row === null || row.disconnectedAt !== undefined || row.health === "reconnect_required") return null;
    return {
      address: row.address,
      products: row.products,
      gmailFolders: row.gmail?.folders ?? [],
      push: row.push ?? {},
    };
  },
});

const failureFields = {
  failedAt: v.optional(v.number()),
  failure: v.optional(v.string()),
};

/**
 * What one registration attempt learned, for one product. A failure keeps the
 * last good registration — a watch that has not expired still delivers — and
 * records when, so the next attempt waits instead of retrying every pass.
 */
export const recordPushWatch = internalMutation({
  args: {
    connectionId: v.id("googleConnections"),
    gmail: v.optional(
      v.object({
        address: v.optional(v.string()),
        topic: v.optional(v.string()),
        expiresAt: v.optional(v.number()),
        ...failureFields,
      }),
    ),
    calendar: v.optional(
      v.object({
        channelId: v.optional(v.string()),
        resourceId: v.optional(v.string()),
        tokenHash: v.optional(v.string()),
        address: v.optional(v.string()),
        expiresAt: v.optional(v.number()),
        ...failureFields,
      }),
    ),
    chat: v.optional(
      v.object({
        subscriptionName: v.optional(v.string()),
        topic: v.optional(v.string()),
        expiresAt: v.optional(v.number()),
        ...failureFields,
      }),
    ),
  },
  returns: v.object({ accepted: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row === null || row.disconnectedAt !== undefined) return { accepted: false };
    const push = { ...(row.push ?? {}) };
    for (const product of ["gmail", "calendar", "chat"] as const) {
      const update = args[product];
      if (update === undefined || !row.products.includes(product)) continue;
      const failed = update.failedAt !== undefined;
      // A failed attempt changes only the failure fields; a success replaces
      // the whole registration and clears any earlier failure.
      (push as Record<string, unknown>)[product] = failed
        ? { ...(push[product] ?? {}), failedAt: update.failedAt, failure: update.failure?.slice(0, 160) }
        : { ...update, failedAt: undefined, failure: undefined };
    }
    await ctx.db.patch(args.connectionId, { push });
    return { accepted: true };
  },
});
