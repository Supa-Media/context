/**
 * Storage falling behind the file tree: a check every 15 minutes, and a mail
 * to staff who asked for one (project file `move-engine/plan.md`, step C).
 *
 * A folder move is drawn in the tree at once and copied in the bucket behind
 * it (`nodeMoves.ts`). The promise is that the bucket catches up within five
 * hours. A move that is four hours old, whose pace says it will miss the
 * five, or that is stuck is *late* (`moveLag.ts`): the check marks it once and
 * mails staff, and its finish mails them that it caught up. One mail each way
 * per move, never one per check.
 *
 * Opt-in per staff member from admin › Search › Indexes, with the same
 * send-time staff check as signup alerts (`signupAlerts.ts`), so a
 * self-hosted deployment never mails anybody who did not ask. A handle,
 * counts, times and fixed labels: never a path, never a folder's name.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { isAdminEmail, requireAdmin, type AdminActor } from "./lib/admin";
import { toConvexError } from "./lib/adminFns/errors";
import { validAppOrigin } from "./lib/invitationEmail";
import { etaMs, lateReason, remainingOf } from "./lib/nodes/moveLag";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { renderStorageLagAlert, type StorageLagFacts } from "./lib/storageLagEmail";

/** A ceiling across the deployment, so a bad hour is a few mails and the console, not a flood. */
export const STORAGE_LAG_ALERTS_PER_HOUR = 12;
const WINDOW_MS = 60 * 60 * 1000;
/** Moves one check reads: a bound on a loop, not on any deployment we have. */
const CHECK_ROWS = 500;
const MAX_SUBSCRIBERS = 50;

const reasonValidator = v.union(v.literal("stuck"), v.literal("old"), v.literal("slow"));
const alertValidator = v.union(
  v.object({
    kind: v.literal("late"),
    workspaceId: v.id("workspaces"),
    reason: reasonValidator,
    ageMs: v.number(),
    remaining: v.number(),
    etaMs: v.union(v.number(), v.null()),
    lastError: v.union(v.string(), v.null()),
  }),
  v.object({ kind: v.literal("recovered"), workspaceId: v.id("workspaces"), tookMs: v.number() }),
);
type Alert =
  | { kind: "late"; workspaceId: Id<"workspaces">; reason: "stuck" | "old" | "slow"; ageMs: number; remaining: number; etaMs: number | null; lastError: string | null }
  | { kind: "recovered"; workspaceId: Id<"workspaces">; tookMs: number };

/** Queue one mail from inside the mutation that decided it. Nobody subscribed means nothing scheduled. */
export async function scheduleStorageLagAlert(ctx: MutationCtx, alert: Alert): Promise<void> {
  if ((await ctx.db.query("storageLagSubscribers").first()) === null) return;
  const room = await tryConsumeRateLimit(ctx, { key: "storageLagAlerts", limit: STORAGE_LAG_ALERTS_PER_HOUR, windowMs: WINDOW_MS });
  if (!room) {
    console.log(JSON.stringify({ event: "storage_lag_alert_skipped", kind: alert.kind, reason: "rate_limited" }));
    return;
  }
  await ctx.scheduler.runAfter(0, internal.functions.storageLag.send, { alert });
}

/** The cron (`crons.ts`): mark each move that has fallen behind, once, and tell staff. */
export const check = internalMutation({
  args: {},
  returns: v.object({ late: v.number(), marked: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    let late = 0;
    let marked = 0;
    for (const row of await ctx.db.query("moveQueue").take(CHECK_ROWS)) {
      const reason = lateReason(row, now);
      if (reason === null) continue;
      late += 1;
      if (row.lateAt !== undefined) continue;
      marked += 1;
      await ctx.db.patch(row._id, { lateAt: now });
      console.log(JSON.stringify({ event: "storage_lag_late", workspaceId: row.workspaceId, reason }));
      await scheduleStorageLagAlert(ctx, {
        kind: "late",
        workspaceId: row.workspaceId,
        reason,
        ageMs: now - row.createdAt,
        remaining: remainingOf(row),
        etaMs: etaMs(row),
        lastError: row.lastError ?? null,
      });
    }
    return { late, marked };
  },
});

/** Who to mail, and the workspace's handle. */
export const facts = internalQuery({
  args: { alert: alertValidator },
  returns: v.object({ recipients: v.array(v.string()), workspace: v.string() }),
  handler: async (ctx, { alert }) => {
    const workspace = await ctx.db.get(alert.workspaceId);
    const name = workspace?.slug ? `@${workspace.slug}` : `workspace ${alert.workspaceId}`;
    const recipients = new Set<string>();
    for (const sub of await ctx.db.query("storageLagSubscribers").take(MAX_SUBSCRIBERS)) {
      const user = await ctx.db.get(sub.userId);
      // Verified, and still staff: the same two things `requireAdmin` asks.
      if (user === null || user.emailVerificationTime === undefined) continue;
      if (typeof user.email !== "string" || !isAdminEmail(user.email)) continue;
      recipients.add(user.email.trim().toLowerCase());
    }
    return { recipients: [...recipients], workspace: name };
  },
});

/** One message per staff member. With no Resend key it does nothing and says so. */
export const send = internalAction({
  args: { alert: alertValidator },
  returns: v.null(),
  handler: async (ctx, { alert }) => {
    const log = (event: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event: `storage_lag_alert_${event}`, kind: alert.kind, ...extra }));
    const apiKey = process.env.RESEND_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      log("skipped", { reason: "resend_unconfigured" });
      return null;
    }
    const origin = validAppOrigin();
    if (origin === null) {
      log("skipped", { reason: "app_origin_unset" });
      return null;
    }
    const found = await ctx.runQuery(internal.functions.storageLag.facts, { alert });
    if (found.recipients.length === 0) return null;
    const about: StorageLagFacts =
      alert.kind === "late"
        ? { kind: "late", workspace: found.workspace, reason: alert.reason, ageMs: alert.ageMs, remaining: alert.remaining, etaMs: alert.etaMs, lastError: alert.lastError }
        : { kind: "recovered", workspace: found.workspace, tookMs: alert.tookMs };
    const rendered = renderStorageLagAlert(about, new URL("/admin", origin).toString());
    for (const to of found.recipients) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: process.env.AUTH_EMAIL_FROM ?? "hello@context.lc",
            to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          }),
        });
        // The status only: Resend's error body quotes the address.
        log(response.ok ? "sent" : "failed", response.ok ? {} : { status: response.status });
      } catch {
        log("failed", { reason: "transport_error" });
      }
    }
    return null;
  },
});

async function staff(ctx: QueryCtx): Promise<AdminActor> {
  try {
    return await requireAdmin(ctx);
  } catch (error) {
    throw toConvexError(error);
  }
}

async function subscription(ctx: QueryCtx, actor: AdminActor) {
  return await ctx.db
    .query("storageLagSubscribers")
    .withIndex("by_user", (q) => q.eq("userId", actor.userId))
    .first();
}

/** The caller's "Email me when storage falls behind" switch. */
export const getAlerts = query({
  args: {},
  returns: v.object({ on: v.boolean(), email: v.string() }),
  handler: async (ctx) => {
    const actor = await staff(ctx);
    return { on: (await subscription(ctx, actor)) !== null, email: actor.email };
  },
});

export const setAlerts = mutation({
  args: { on: v.boolean() },
  returns: v.object({ on: v.boolean(), email: v.string() }),
  handler: async (ctx, { on }) => {
    const actor = await staff(ctx);
    const existing = await subscription(ctx, actor);
    if (on && existing === null) await ctx.db.insert("storageLagSubscribers", { userId: actor.userId, createdAt: Date.now() });
    if (!on && existing !== null) await ctx.db.delete(existing._id);
    return { on, email: actor.email };
  },
});
