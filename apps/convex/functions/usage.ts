/**
 * Counting what the product is doing, without recording what anyone wrote.
 *
 * ## The line this module is built along
 *
 * There is already a record of what a person did in their own context: the
 * audit trail, in **their** bucket, under `.audit/`, which they can read,
 * export and delete. Building the admin dashboard by reading that would
 * quietly convert a customer-owned record into a product-analytics pipeline,
 * which is the move CLAUDE.md's first non-negotiable forbids.
 *
 * So nothing here reads a bucket, and nothing here stores an event. A caller
 * says "one more of *this named thing* happened", and a counter for the day
 * goes up by one. What is structurally absent — not omitted, absent — is any
 * field a path, a query, a note title or a sub-day timestamp could occupy. The
 * metric name comes from a closed list (`lib/usage.ts`) and an unrecognized one
 * is dropped rather than stored, so a compromised or buggy caller cannot fill
 * the table with strings of its choosing.
 *
 * ## Counters, and one cardinality
 *
 * `usageDaily` sums. "How many distinct contexts were active" is not a sum, so
 * `usageActiveDaily` holds one row per context per day per surface, written
 * once and then left alone. That a context was active is the entire content of
 * the row.
 *
 * ## Reporting is best-effort, and must never fail the thing it counts
 *
 * A search that works but cannot be counted is a good outcome; a search that
 * fails because the counter was down is not. Every path into here is called
 * behind the response (`ctx.waitUntil` in the gateway) or with its failure
 * swallowed, and none of them is on the critical path of anything a person is
 * waiting for.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  dayKey,
  isUsageMetric,
  isUsageSurface,
  PER_WORKSPACE_METRICS,
  type UsageMetric,
  type UsageSurface,
} from "./lib/usage";

/**
 * How much one report may add at once.
 *
 * A batch is one Worker invocation's worth of activity, which is a handful of
 * calls. The cap is here because the batch arrives over an HTTP route: without
 * it, a single request can ask this mutation to do unbounded work.
 */
export const MAX_BATCH_EVENTS = 50;

/** And how much one event may claim. A tool call is one thing happening. */
export const MAX_EVENT_COUNT = 1_000;

export interface UsageEvent {
  metric: UsageMetric;
  workspaceId?: Id<"workspaces">;
  count: number;
}

/**
 * Add `count` to one day's counter, creating the row if it is the day's first.
 *
 * Read-modify-write inside a Convex mutation, which is transactional, so two
 * concurrent reports do not lose an increment the way they would against a
 * store without one.
 */
async function bump(
  ctx: MutationCtx,
  day: string,
  metric: UsageMetric,
  workspaceId: Id<"workspaces"> | undefined,
  count: number,
): Promise<void> {
  const existing = await ctx.db
    .query("usageDaily")
    .withIndex("by_day_metric_workspace", (q) =>
      q.eq("day", day).eq("metric", metric).eq("workspaceId", workspaceId),
    )
    .unique();

  if (existing === null) {
    await ctx.db.insert("usageDaily", {
      day,
      metric,
      workspaceId,
      count,
      updatedAt: Date.now(),
    });
    return;
  }
  await ctx.db.patch(existing._id, {
    count: existing.count + count,
    updatedAt: Date.now(),
  });
}

/**
 * Note that a context was active today, at most once per surface per day.
 *
 * The existence check is what keeps this a cardinality table rather than an
 * event log: a context that makes ten thousand calls writes one row.
 */
async function markActive(
  ctx: MutationCtx,
  day: string,
  workspaceId: Id<"workspaces">,
  surface: UsageSurface,
): Promise<void> {
  const existing = await ctx.db
    .query("usageActiveDaily")
    .withIndex("by_day_surface_workspace", (q) =>
      q.eq("day", day).eq("surface", surface).eq("workspaceId", workspaceId),
    )
    .unique();
  if (existing !== null) return;
  await ctx.db.insert("usageActiveDaily", {
    day,
    workspaceId,
    surface,
    at: Date.now(),
  });
}

/**
 * Apply a batch of counted events.
 *
 * Internal: the callers are the gateway's HTTP route and this control plane's
 * own mutations. It is never client-callable, because a client that can
 * increment arbitrary counters can make the dashboard say anything.
 *
 * **Unrecognized input is dropped, not rejected.** A caller reporting a metric
 * this deployment does not know is almost always a gateway running a newer or
 * older build than the control plane, and failing its request would turn a
 * cosmetic version skew into a broken tool call. What must not happen is the
 * name being *stored*; that is the part this enforces.
 */
export const record = internalMutation({
  args: {
    events: v.array(
      v.object({
        metric: v.string(),
        workspaceId: v.optional(v.id("workspaces")),
        count: v.optional(v.number()),
      }),
    ),
    surface: v.optional(v.string()),
    /** Test seam. Absent means now; never supplied by a remote caller. */
    at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.at ?? Date.now();
    const day = dayKey(now);
    const surface = isUsageSurface(args.surface) ? args.surface : undefined;

    let applied = 0;
    for (const event of args.events.slice(0, MAX_BATCH_EVENTS)) {
      if (!isUsageMetric(event.metric)) continue;

      // A count that is not a positive whole number is one event. Clamping
      // rather than refusing keeps a rounding bug upstream from stopping the
      // request it is attached to, and the cap stops one report claiming a
      // year's activity.
      const raw = event.count ?? 1;
      const count =
        Number.isFinite(raw) && raw > 0
          ? Math.min(Math.floor(raw), MAX_EVENT_COUNT)
          : 1;

      // A per-workspace metric without a workspace, or a platform-wide metric
      // carrying one, is a caller confused about what it is reporting. The
      // workspace is dropped rather than the event: the total stays true, and
      // the breakdown does not gain a row that means something else.
      const workspaceId = PER_WORKSPACE_METRICS.has(event.metric)
        ? event.workspaceId
        : undefined;

      await bump(ctx, day, event.metric, workspaceId, count);
      if (workspaceId !== undefined && surface !== undefined) {
        await markActive(ctx, day, workspaceId, surface);
      }
      applied += 1;
    }
    return { applied };
  },
});

/**
 * The console reporting its own use.
 *
 * Public and authenticated, and it takes **no metric argument**: it records
 * exactly one thing, that a signed-in person opened the app today. A public
 * mutation that accepted a metric name and a count would let any account write
 * the dashboard's numbers.
 *
 * The workspace is checked for membership rather than trusted, for the
 * ordinary reason — otherwise anybody can mark any context active and learn
 * nothing, but make the figures a lie.
 */
export const reportAppSession = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { recorded: false };

    const day = dayKey(Date.now());

    let workspaceId: Id<"workspaces"> | undefined;
    if (args.workspaceId !== undefined) {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", args.workspaceId!).eq("userId", userId),
        )
        .unique();
      if (membership !== null) workspaceId = args.workspaceId;
    }

    await bump(ctx, day, "app.session", workspaceId, 1);
    if (workspaceId !== undefined) {
      await markActive(ctx, day, workspaceId, "app");
    }
    return { recorded: true };
  },
});
