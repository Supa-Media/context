/**
 * Which of a person's Google connections writes their calendar, and whether
 * they have room for one more change (`lib/calendarWrite.ts`,
 * `docs/decisions/communications/calendar-writes.md`).
 *
 * One mutation, so the check and the spend are one transaction, as
 * `personEmail.ts` does for email: every limit is read first and only then,
 * when all have room, spent together. With `spend: false` it only answers
 * whether the change could go, which the gateway asks before it puts the
 * change to the person.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { ownAccountClearance } from "./lib/controlPlane/ownAccount";
import { calendarWritePolicies } from "./lib/calendarWrite";
import { canWriteCalendar } from "./lib/googleOAuth";
import type { RateLimitPolicy } from "./lib/rateLimit";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { aiScopesOf } from "./lib/googleConnect/aiScopes";

const refusal = v.union(
  v.literal("not_allowed"),
  v.literal("no_calendar"),
  v.literal("calendar_read_only"),
  v.literal("hourly_limit"),
  v.literal("daily_limit"),
);

/** Whether this key has room for one more, without spending it. */
async function hasRoom(ctx: MutationCtx, policy: RateLimitPolicy): Promise<boolean> {
  const row = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", policy.key))
    .unique();
  if (row === null || Date.now() - row.windowStartedAt >= policy.windowMs) return true;
  return row.count < policy.limit;
}

export const claimCalendarWrite = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.string(),
    action: v.union(v.literal("create"), v.literal("edit"), v.literal("move"), v.literal("cancel"), v.literal("rsvp")),
    spend: v.boolean(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      address: v.string(),
      connectionId: v.id("googleConnections"),
      /** Every connection that may change a calendar, the first one first: an existing event is looked for on each. */
      writers: v.array(v.object({ address: v.string(), connectionId: v.id("googleConnections") })),
    }),
    v.object({ ok: v.literal(false), refused: refusal }),
  ),
  handler: async (ctx, args) => {
    // The grant's own person's calendar, from their personal workspace, or a
    // group chat's tagger's (`lib/controlPlane/ownAccount.ts`): an editor
    // grant on a shared workspace never reaches its holder's calendar.
    const cleared = await ownAccountClearance(ctx, {
      hashedAccessToken: args.hashedAccessToken,
      expectedWorkspaceId: args.expectedWorkspaceId,
    });
    if (cleared === null) return { ok: false as const, refused: "not_allowed" as const };
    const personal = cleared.personal;
    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", personal._id))
      .take(20);
    const writers = connections.filter(
      (row) => row.disconnectedAt === undefined && row.products.includes("calendar") && canWriteCalendar(aiScopesOf(row)),
    );
    const writer = writers[0];
    if (writer === undefined) {
      // Connected, but before the consent asked to change it: one reconnect
      // grants it, which "not connected" would never get the person to do.
      const reader = connections.some((row) => row.disconnectedAt === undefined && row.products.includes("calendar"));
      return { ok: false as const, refused: reader ? ("calendar_read_only" as const) : ("no_calendar" as const) };
    }
    const policies = calendarWritePolicies(cleared.actorUserId);
    for (const policy of policies) {
      if (!(await hasRoom(ctx, policy))) return { ok: false as const, refused: policy.refusal };
    }
    const claimed = {
      ok: true as const,
      address: writer.address,
      connectionId: writer._id,
      writers: writers.map((row) => ({ address: row.address, connectionId: row._id })),
    };
    if (!args.spend) return claimed;
    for (const policy of policies) {
      // Every one was checked above in this same transaction, so none refuses here.
      await tryConsumeRateLimit(ctx, policy);
    }
    await recordAudit(ctx, {
      workspaceId: personal._id,
      actorUserId: cleared.actorUserId,
      actorClientId: cleared.clientId,
      action: "calendar_event",
      // What kind of change, never what the event is.
      details: { change: args.action },
    });
    return claimed;
  },
});
