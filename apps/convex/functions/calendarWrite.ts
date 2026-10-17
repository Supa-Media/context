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
import { ownedPersonalWorkspace } from "./lib/accountSetup";
import { editorClearanceForGatewayHandler } from "./lib/controlPlane/session";
import { CALENDAR_WRITE_SCOPE, calendarWritePolicies } from "./lib/calendarWrite";
import type { RateLimitPolicy } from "./lib/rateLimit";
import { tryConsumeRateLimit } from "./lib/rateLimit";

const refusal = v.union(v.literal("not_allowed"), v.literal("no_calendar"), v.literal("hourly_limit"), v.literal("daily_limit"));

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
    action: v.union(v.literal("create"), v.literal("move"), v.literal("cancel")),
    spend: v.boolean(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), address: v.string(), connectionId: v.id("googleConnections") }),
    v.object({ ok: v.literal(false), refused: refusal }),
  ),
  handler: async (ctx, args) => {
    // A live grant that may write, on the person's own personal workspace:
    // an editor grant on a shared one never reaches its holder's calendar.
    const cleared = await editorClearanceForGatewayHandler(ctx, {
      hashedAccessToken: args.hashedAccessToken,
      expectedWorkspaceId: args.expectedWorkspaceId,
    });
    if (cleared === null) return { ok: false as const, refused: "not_allowed" as const };
    const personal = await ownedPersonalWorkspace(ctx, cleared.actorUserId);
    if (personal === null || personal.createdBy !== cleared.actorUserId || cleared.workspaceId !== personal._id) {
      return { ok: false as const, refused: "not_allowed" as const };
    }
    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", personal._id))
      .take(20);
    const writer = connections.find(
      (row) => row.disconnectedAt === undefined && row.products.includes("calendar") && row.scopes.includes(CALENDAR_WRITE_SCOPE),
    );
    if (writer === undefined) return { ok: false as const, refused: "no_calendar" as const };
    const policies = calendarWritePolicies(cleared.actorUserId);
    for (const policy of policies) {
      if (!(await hasRoom(ctx, policy))) return { ok: false as const, refused: policy.refusal };
    }
    const claimed = { ok: true as const, address: writer.address, connectionId: writer._id };
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
