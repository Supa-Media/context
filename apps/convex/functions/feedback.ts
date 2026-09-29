/**
 * In-app feedback: the report a signed-in person sends from the bug button,
 * the account menu, Settings or the broken page, taken in and sent on to
 * Sentry from here.
 *
 * ## Why the control plane sits in the path
 *
 * The app used to hand the report to the Sentry SDK itself. That left every
 * limit the report screen promises — ten a day, a bounded message, a log of
 * route names and nothing else, a small picture — enforced only by the app,
 * which is to say by whoever is running the client. Here they are enforced
 * where a client cannot skip them, and the app never holds a Sentry key for
 * feedback.
 *
 * ## What is kept, and what is not
 *
 * The report itself is never written anywhere in the control plane: it is
 * checked in memory (`lib/feedback/report.ts`), built into one envelope
 * (`lib/feedback/envelope.ts`) and posted. `feedbackReceipts` keeps the ids,
 * a state and times, which is what the retry and the limit need.
 *
 * ## The order, and why
 *
 * 1. Check the caller and the report, before anything is stored.
 * 2. Reserve: one mutation decides, atomically, whether this is a report
 *    already sent (answer its event id), one being sent right now (busy),
 *    one over the day's limit (refuse), or a new one (reserve it under a
 *    fresh Sentry event id). Pending reservations count toward the limit, so
 *    eleven sends at once cannot all slip through.
 * 3. Post the envelope.
 * 4. Record it sent — or, on failure, release the reservation so the report
 *    neither counts against the limit nor blocks its own retry.
 *
 * A reservation left behind by a send that died between 3 and 4 is resumed
 * after `STALE_SENDING_MS` under the **same** event id, so if the first post
 * did reach Sentry, the second is the same event and Sentry keeps one copy.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { FEEDBACK_LIMITS } from "@context/shared";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalMutation, query } from "../_generated/server";
import { buildFeedbackEnvelope, parseDsn, type SentryTarget } from "./lib/feedback/envelope";
import { parseFeedbackReport } from "./lib/feedback/report";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long receipts are kept: long enough to recognise a late retry. */
export const FEEDBACK_RECEIPT_RETENTION_MS = 30 * DAY_MS;

/** A send older than this that never finished is taken to have died. */
export const STALE_SENDING_MS = 2 * 60 * 1000;

/** How long a post to Sentry may take before the report is kept for later. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * Where reports go, or null when this deployment takes none: no DSN (a
 * self-hosted deployment, or one nobody configured), or the brake
 * `FEEDBACK_INTAKE=disabled`.
 */
function target(): SentryTarget | null {
  if (process.env.FEEDBACK_INTAKE?.trim().toLowerCase() === "disabled") return null;
  return parseDsn(process.env.FEEDBACK_SENTRY_DSN);
}

function environment(): string {
  const name = process.env.APP_ENV?.trim().toLowerCase();
  return name === "staging" || name === "development" || name === "preview" ? name : "production";
}

function newEventId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether a signed-in caller could send a report now — for showing the entry points. */
export const feedbackAvailable = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    if ((await getAuthUserId(ctx)) === null) return false;
    return target() !== null;
  },
});

export const submitFeedback = action({
  args: {
    clientReportId: v.string(),
    message: v.string(),
    source: v.string(),
    screen: v.string(),
    activity: v.optional(v.string()),
    errorEventId: v.optional(v.string()),
    screenshot: v.optional(v.bytes()),
    screenshotType: v.optional(v.string()),
    app: v.object({ platform: v.string(), build: v.optional(v.string()) }),
    system: v.optional(v.object({ family: v.string(), version: v.optional(v.string()) })),
  },
  returns: v.object({ eventId: v.string() }),
  handler: async (ctx, args): Promise<{ eventId: string }> => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) {
      throw new ConvexError({ code: "FEEDBACK_UNAUTHENTICATED", message: "Sign in to send a report." });
    }
    const sentry = target();
    if (sentry === null) {
      throw new ConvexError({ code: "FEEDBACK_NOT_CONFIGURED", message: "This deployment takes no reports." });
    }
    const report = parseFeedbackReport(args);

    const now = Date.now();
    const reservation: Reservation = await ctx.runMutation(internal.functions.feedback.reserveFeedback, {
      userId,
      clientReportId: report.clientReportId,
      now,
    });
    if (reservation.kind === "sent") return { eventId: reservation.eventId };
    if (reservation.kind === "busy") {
      throw new ConvexError({ code: "FEEDBACK_BUSY", message: "This report is already being sent." });
    }
    if (reservation.kind === "limited") {
      throw new ConvexError({
        code: "FEEDBACK_RATE_LIMITED",
        message: "That's the day's reports. It will go tomorrow.",
        retryAfterMs: reservation.retryAfterMs,
      });
    }

    const body = buildFeedbackEnvelope({
      dsn: sentry.dsn,
      eventId: reservation.eventId,
      userId,
      environment: environment(),
      now,
      report,
    });
    let delivered = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await fetch(sentry.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope" },
        body,
        signal: controller.signal,
      });
      delivered = response.ok;
    } catch {
      // Network failure or timeout: the report was not taken. Its content is
      // not logged, here or anywhere.
      delivered = false;
    } finally {
      clearTimeout(timer);
    }

    if (!delivered) {
      await ctx.runMutation(internal.functions.feedback.releaseFeedback, { receiptId: reservation.receiptId });
      throw new ConvexError({ code: "FEEDBACK_UNAVAILABLE", message: "The report could not be sent just now." });
    }
    await ctx.runMutation(internal.functions.feedback.markFeedbackSent, { receiptId: reservation.receiptId });
    return { eventId: reservation.eventId };
  },
});

type Reservation =
  | { kind: "sent"; eventId: string }
  | { kind: "busy" }
  | { kind: "limited"; retryAfterMs: number }
  | { kind: "reserved"; eventId: string; receiptId: Id<"feedbackReceipts"> };

/** Step 2 of the module comment: decide, atomically, what this send is. */
export const reserveFeedback = internalMutation({
  args: { userId: v.id("users"), clientReportId: v.string(), now: v.number() },
  returns: v.union(
    v.object({ kind: v.literal("sent"), eventId: v.string() }),
    v.object({ kind: v.literal("busy") }),
    v.object({ kind: v.literal("limited"), retryAfterMs: v.number() }),
    v.object({ kind: v.literal("reserved"), eventId: v.string(), receiptId: v.id("feedbackReceipts") }),
  ),
  handler: async (ctx, { userId, clientReportId, now }) => {
    const existing = await ctx.db
      .query("feedbackReceipts")
      .withIndex("by_user_client", (q) => q.eq("userId", userId).eq("clientReportId", clientReportId))
      .first();
    if (existing !== null) {
      if (existing.state === "sent") return { kind: "sent" as const, eventId: existing.eventId };
      if (now - existing.createdAt < STALE_SENDING_MS) return { kind: "busy" as const };
      // A send that died: resume it under the same event id. It already
      // counted toward the limit when it was reserved.
      await ctx.db.patch(existing._id, { createdAt: now });
      return { kind: "reserved" as const, eventId: existing.eventId, receiptId: existing._id };
    }

    const recent = await ctx.db
      .query("feedbackReceipts")
      .withIndex("by_user_created", (q) => q.eq("userId", userId).gt("createdAt", now - DAY_MS))
      .take(FEEDBACK_LIMITS.perDay);
    if (recent.length >= FEEDBACK_LIMITS.perDay) {
      // A rolling day: room opens when the oldest counted report turns a day old.
      const oldest = Math.min(...recent.map((row) => row.createdAt));
      return { kind: "limited" as const, retryAfterMs: Math.max(1, oldest + DAY_MS - now) };
    }

    const eventId = newEventId();
    const receiptId = await ctx.db.insert("feedbackReceipts", {
      userId,
      clientReportId,
      eventId,
      state: "sending",
      createdAt: now,
    });
    return { kind: "reserved" as const, eventId, receiptId };
  },
});

export const markFeedbackSent = internalMutation({
  args: { receiptId: v.id("feedbackReceipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const row = await ctx.db.get(receiptId);
    if (row !== null) await ctx.db.patch(receiptId, { state: "sent", sentAt: Date.now() });
    return null;
  },
});

/** A send that failed: gone, so it neither counts nor blocks its own retry. */
export const releaseFeedback = internalMutation({
  args: { receiptId: v.id("feedbackReceipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const row = await ctx.db.get(receiptId);
    if (row !== null && row.state === "sending") await ctx.db.delete(receiptId);
    return null;
  },
});

/** Receipts past their thirty days, a batch at a time (hourly cron). */
export const purgeExpiredFeedbackReceipts = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), moreRemaining: v.boolean() }),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
    const cutoff = Date.now() - FEEDBACK_RECEIPT_RETENTION_MS;
    const stale = await ctx.db
      .query("feedbackReceipts")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(limit);
    for (const row of stale) await ctx.db.delete(row._id);
    const moreRemaining = stale.length === limit;
    if (moreRemaining) {
      await ctx.scheduler.runAfter(0, internal.functions.feedback.purgeExpiredFeedbackReceipts, { limit });
    }
    return { deleted: stale.length, moreRemaining };
  },
});
