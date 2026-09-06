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
 * The longest window any caller may use, and the reason retention is derived.
 *
 * The first version of this said retention was "generous against the longest
 * window any caller uses (an hour)" and set it to 24 hours. **That was false
 * when written**: `invitationEmail.ts`'s `RECIPIENT_MAIL_WINDOW_MS` is 24
 * hours, so retention equalled the longest window and the margin was zero. It
 * was safe only by coincidence — `windowExpired` here compares `>=` and the
 * sweep compares `<`, so the two line up exactly at the boundary and the swept
 * set stays a strict subset of the dead set. One comparison operator away from
 * refunding somebody's anti-abuse budget on outbound mail.
 *
 * So the margin is structural now rather than asserted: retention is twice the
 * longest permitted window, and a window longer than this is refused at the
 * call rather than silently outliving the sweep. `__tests__/rateLimit.test.ts`
 * holds the two together.
 */
export const MAX_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long a closed window is kept before it is swept.
 *
 * The only cost of keeping a dead row longer is the row. The cost of deleting
 * a *live* one is a caller handed their spent budget back, which on the two
 * routes a stranger can drive is the anti-abuse property itself — hence a
 * multiple of the longest window rather than a number that looks comfortable.
 */
export const RATE_LIMIT_RETENTION_MS = 2 * MAX_RATE_LIMIT_WINDOW_MS;

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
  if (policy.windowMs > MAX_RATE_LIMIT_WINDOW_MS) {
    /*
      A window longer than the sweep's retention would have its counters
      deleted while still live, handing the caller their spent budget back.
      Refused here rather than left to be noticed, because the failure is
      silent everywhere else: the limit simply stops limiting.
    */
    throw new Error(
      `rate limit window ${policy.windowMs}ms exceeds MAX_RATE_LIMIT_WINDOW_MS; raise it and the retention together`,
    );
  }
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
