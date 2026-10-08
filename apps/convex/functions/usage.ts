/**
 * Counting what the product is doing, without recording what anyone wrote.
 *
 * ## The line this module is built along
 *
 * There is already a record of what a person did in their own context: the
 * audit trail, in **their** bucket, under `.context/audit/`, which they can read,
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
import { internal } from "../_generated/api";
import { planIsPaying } from "./lib/premium";
import {
  clientFamily,
  dayKey,
  HOURLY_RETENTION_DAYS,
  hourOf,
  isHourlyMetric,
  isTokenMethod,
  MAX_MODELS_PER_WORKSPACE_DAY,
  MAX_TOKEN_EVENT_COUNT,
  normalizeModel,
  type ClientFamily,
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
  returns: v.object({ recorded: v.boolean() }),
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

/** How much one hourly report may add at once, for the same reason as `MAX_BATCH_EVENTS`. */
export const MAX_HOURLY_BATCH_EVENTS = 50;

/**
 * Apply a batch of Premium usage analytics (`usageHourly`).
 *
 * Internal, like `record`, and with the same rule for bad input: dropped, not
 * rejected, so version skew between gateway and control plane costs a figure,
 * never a tool call.
 *
 * **Premium only.** A workspace whose plan is not paying writes nothing here.
 * Checked once per workspace per batch, from `workspacePlans`, the same row
 * `lib/premium.ts` reads.
 *
 * Token events also bump a platform-wide `usageDaily` total for the agent's
 * client family, which is all the admin dashboard sees of them.
 */
export const recordHourly = internalMutation({
  args: {
    events: v.array(
      v.object({
        metric: v.string(),
        workspaceId: v.id("workspaces"),
        userId: v.optional(v.id("users")),
        clientId: v.string(),
        model: v.optional(v.string()),
        method: v.string(),
        count: v.number(),
      }),
    ),
    /** Test seam. Absent means now; never supplied by a remote caller. */
    at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.at ?? Date.now();
    const day = dayKey(now);
    const hour = hourOf(now);
    const premium = new Map<string, boolean>();
    const families = new Map<string, ClientFamily>();

    let applied = 0;
    for (const event of args.events.slice(0, MAX_HOURLY_BATCH_EVENTS)) {
      if (!isHourlyMetric(event.metric) || !isTokenMethod(event.method)) continue;
      if (event.clientId.length === 0 || event.clientId.length > 128) continue;
      // Zero is nothing to record, unlike `record`, where it means one.
      if (!Number.isFinite(event.count) || event.count < 1) continue;
      const count = Math.min(Math.floor(event.count), MAX_TOKEN_EVENT_COUNT);

      if (!premium.has(event.workspaceId)) {
        premium.set(event.workspaceId, await workspaceIsPaying(ctx, event.workspaceId));
      }
      if (!premium.get(event.workspaceId)) continue;

      const model = await boundedModel(ctx, event.workspaceId, day, normalizeModel(event.model));
      await bumpHourly(ctx, {
        day,
        hour,
        workspaceId: event.workspaceId,
        userId: event.userId,
        clientId: event.clientId,
        model,
        metric: event.metric,
        method: event.method,
      }, count);

      if (event.metric === "mcp.request_tokens" || event.metric === "mcp.response_tokens") {
        if (!families.has(event.clientId)) {
          const client = await ctx.db
            .query("oauthClients")
            .withIndex("by_clientId", (q) => q.eq("clientId", event.clientId))
            .first();
          families.set(event.clientId, clientFamily(client?.clientName));
        }
        const total = `${event.metric}.${families.get(event.clientId)}` as UsageMetric;
        await bump(ctx, day, total, undefined, count);
      }
      applied += 1;
    }
    return { applied };
  },
});

async function workspaceIsPaying(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  const plans = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  return plans.some((plan) => planIsPaying(plan.status));
}

/**
 * `model`, unless this workspace already has `MAX_MODELS_PER_WORKSPACE_DAY`
 * others today, in which case "other".
 */
async function boundedModel(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  day: string,
  model: string,
): Promise<string> {
  if (model === "other" || model === "unknown") return model;
  // The common case, one indexed read: this model already has a row today.
  const known = await ctx.db
    .query("usageHourly")
    .withIndex("by_workspace_day_model", (q) =>
      q.eq("workspaceId", workspaceId).eq("day", day).eq("model", model),
    )
    .first();
  if (known !== null) return model;
  // lean: a model new today scans the day's rows to count distinct models,
  // rare by nature; a per-day model list would make it one read.
  const rows = await ctx.db
    .query("usageHourly")
    .withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId).eq("day", day))
    .collect();
  const seen = new Set(rows.map((row) => row.model));
  if (seen.has(model) || seen.size < MAX_MODELS_PER_WORKSPACE_DAY) return model;
  return "other";
}

interface HourlyKey {
  day: string;
  hour: number;
  workspaceId: Id<"workspaces">;
  userId: Id<"users"> | undefined;
  clientId: string;
  model: string;
  metric: string;
  method: string;
}

async function bumpHourly(ctx: MutationCtx, key: HourlyKey, count: number): Promise<void> {
  const existing = await ctx.db
    .query("usageHourly")
    .withIndex("by_key", (q) =>
      q
        .eq("workspaceId", key.workspaceId)
        .eq("day", key.day)
        .eq("hour", key.hour)
        .eq("metric", key.metric)
        .eq("clientId", key.clientId)
        .eq("model", key.model)
        .eq("method", key.method)
        .eq("userId", key.userId),
    )
    .unique();
  if (existing === null) {
    await ctx.db.insert("usageHourly", { ...key, count });
    return;
  }
  await ctx.db.patch(existing._id, { count: existing.count + count });
}

/** How many old hourly rows one prune pass deletes; the cron runs again tomorrow. */
const PRUNE_BATCH = 4_000;

/** Delete `usageHourly` rows older than `HOURLY_RETENTION_DAYS`. Daily cron. */
export const pruneHourly = internalMutation({
  args: { at: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = dayKey((args.at ?? Date.now()) - HOURLY_RETENTION_DAYS * 86_400_000);
    const old = await ctx.db
      .query("usageHourly")
      .withIndex("by_day", (q) => q.lt("day", cutoff))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    return { deleted: old.length };
  },
});

/**
 * Delete a deleted workspace's `usageHourly` rows, a batch at a time.
 *
 * Unlike `usageDaily`, these go with the workspace: they name the agents and
 * models a customer used, hour by hour, which is theirs to take with them, not
 * ours to keep. Scheduled from `deleteWorkspaceCascade` and rescheduling
 * itself, because a year of rows can outgrow one mutation.
 */
export const purgeWorkspaceHourly = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("usageHourly")
      .withIndex("by_workspace_day", (q) => q.eq("workspaceId", args.workspaceId))
      .take(PRUNE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.functions.usage.purgeWorkspaceHourly, args);
    }
    return { deleted: rows.length };
  },
});
