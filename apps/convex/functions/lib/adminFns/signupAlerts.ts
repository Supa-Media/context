/**
 * The staff console's signup-alerts switch. Handlers only; `functions/admin.ts`
 * authorizes with `requireAdmin` before calling either.
 */

import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { AdminActor } from "../admin";

async function subscription(ctx: QueryCtx, actor: AdminActor) {
  return ctx.db
    .query("signupAlertSubscribers")
    .withIndex("by_user", (q) => q.eq("userId", actor.userId))
    .first();
}

export async function getSignupAlertsHandler(ctx: QueryCtx, actor: AdminActor) {
  return { on: (await subscription(ctx, actor)) !== null, email: actor.email };
}

export async function setSignupAlertsHandler(ctx: MutationCtx, actor: AdminActor, on: boolean) {
  const existing = await subscription(ctx, actor);
  if (on && existing === null) {
    await ctx.db.insert("signupAlertSubscribers", { userId: actor.userId, createdAt: Date.now() });
  }
  if (!on && existing !== null) await ctx.db.delete(existing._id);
  return { on, email: actor.email };
}
