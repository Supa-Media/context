/**
 * A fixed-window rate limiter, in one table.
 *
 * ## Why this exists
 *
 * Names are the addressing scheme (`@name/1-projects/foo.md`) and a future
 * subdomain, and there is no release, rename, or delete path — a claimed name
 * is claimed forever. The namespace is `[a-z0-9-]{2,32}`, of which the short,
 * memorable end is small: roughly 1.3k two-character names and 46k
 * three-character ones. Without a limit, one authenticated account can claim
 * all of them in minutes, permanently, and every one of those claims is both
 * an availability loss and an impersonation opportunity.
 *
 * ## What it can and cannot do
 *
 * Convex mutations are serializable transactions, so an increment recorded by
 * a mutation that later throws is rolled back with everything else. This
 * limiter therefore counts **successful** mutations, not attempts. That is the
 * right unit for squatting — a failed claim takes nothing out of the
 * namespace — but it does mean this is not a defense against someone hammering
 * an endpoint to make it fail, and it must not be relied on as one.
 *
 * Queries cannot write, so a query cannot self-throttle with this or with any
 * other table-based scheme. `checkNameAvailable` is deliberately left
 * unthrottled for that reason; what limits squatting is the cap on what a
 * probe can be *converted into*, not the probing.
 *
 * The window is fixed rather than sliding: cheap (one row, one read, one
 * write) and honest about its edge — a caller can spend one window's budget at
 * the end of a window and the next window's at the start, so the true
 * worst-case burst is `limit * 2` over a short span. For limits measured in
 * "a handful an hour" that is fine; if a limit ever needs to be tight enough
 * that 2x matters, replace this, do not tune it.
 */

import { ConvexError } from "convex/values";
import type { MutationCtx } from "../../_generated/server";

export interface RateLimitPolicy {
  /**
   * What is being limited, already scoped to whoever is being limited —
   * `workspace.create:<userId>`. Building the key at the call site keeps this
   * module from having to know about identity.
   */
  key: string;
  /** Successful operations allowed per window. */
  limit: number;
  windowMs: number;
}

/**
 * Record one successful use of a limited operation, or throw `RATE_LIMITED`.
 *
 * Call it inside the same mutation as the work it limits, so the two commit or
 * roll back together.
 *
 * The error carries `retryAfterMs` because a client that cannot tell the user
 * when to try again just shows them a dead end.
 */
export async function consumeRateLimit(
  ctx: MutationCtx,
  policy: RateLimitPolicy,
): Promise<void> {
  const now = Date.now();
  const existing = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", policy.key))
    .unique();

  if (existing === null) {
    await ctx.db.insert("rateLimits", {
      key: policy.key,
      windowStartedAt: now,
      count: 1,
    });
    return;
  }

  const windowExpired = now - existing.windowStartedAt >= policy.windowMs;
  if (windowExpired) {
    await ctx.db.patch(existing._id, { windowStartedAt: now, count: 1 });
    return;
  }

  if (existing.count >= policy.limit) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message: "Too many requests. Try again shortly.",
      retryAfterMs: existing.windowStartedAt + policy.windowMs - now,
    });
  }

  await ctx.db.patch(existing._id, { count: existing.count + 1 });
}
