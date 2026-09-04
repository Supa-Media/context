/**
 * The staff console: platform figures, and the platform's own credentials.
 *
 * Every function here begins with `requireAdmin` (`lib/admin.ts`), which
 * authorizes against an environment allowlist rather than a database flag —
 * the reasoning is in that module and it is the load-bearing decision in this
 * file.
 *
 * ## The one rule that shapes everything below
 *
 * **No public function may reach `decryptSecret`.** That is
 * `__tests__/structure.test.ts`, enforced over the whole call graph rather
 * than over names, and it is why this file has the shape it does:
 *
 *  - `setSecret` is an `action` (it encrypts, which needs a random IV, which a
 *    deterministic mutation may not produce) that hands the finished envelope
 *    to an internal mutation. It never reads one back.
 *  - `listSecrets` returns names, fingerprints, descriptions and authorship.
 *    There is no `getSecret`, and adding one would fail the suite rather than
 *    merely be a bad idea.
 *  - `readIntegrationSecret` — the one function that opens an envelope — is an
 *    `internalAction`, reachable by the provisioner and the payment and mail
 *    integrations, and by nothing a client can call.
 *
 * An admin is staff, not an exception to the credential boundary. The console
 * exists so somebody can *set* a token without a deploy, not so anybody can
 * read one out of the product.
 *
 * ## What this file may never grow
 *
 * A function that returns per-note, per-path or per-query figures. The usage
 * tables hold counters by day and nothing else (see `lib/usage.ts`), and the
 * reason is the first non-negotiable: an admin screen is not a licence to
 * hold a record of what customers wrote or searched for.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import {
  AppSecretError,
  fingerprintSecret,
  normalizeSecretDescription,
  normalizeSecretName,
  normalizeSecretValue,
} from "./lib/appSecrets";
import {
  NotAdminError,
  requireAdmin,
  viewerIsAdmin as viewerIsAdminHelper,
  type AdminActor,
} from "./lib/admin";
import { decryptSecret, encryptSecret, requireKeyset } from "./lib/crypto";
import {
  USAGE_METRICS,
  clampReportDays,
  dayKey,
  dayRange,
  type UsageMetric,
} from "./lib/usage";

/** Admin acts worth a trail. A closed set, like the usage metrics. */
export const ADMIN_ACTIONS = [
  "secret.set",
  "secret.updated",
  "secret.deleted",
] as const;

type AdminAction = (typeof ADMIN_ACTIONS)[number];

/**
 * `NotAdminError` and `AppSecretError` are internal shapes; the client sees a
 * `ConvexError` with a code, like every other surface in this control plane.
 *
 * The not-admin case is deliberately indistinguishable from a missing
 * endpoint: same code, same message, whether the caller is signed out, signed
 * in as a stranger, or signed in with an unverified allowlisted address.
 */
function toConvexError(error: unknown): ConvexError<{
  code: string;
  message: string;
}> {
  if (error instanceof NotAdminError) {
    return new ConvexError({ code: "NOT_FOUND", message: "Not found" });
  }
  if (error instanceof AppSecretError) {
    return new ConvexError({ code: "INVALID_SECRET", message: error.message });
  }
  throw error;
}

async function recordAdminAudit(
  ctx: MutationCtx,
  actor: AdminActor,
  action: AdminAction,
  subject: string,
  details?: Record<string, string | number | boolean | null>,
): Promise<void> {
  await ctx.db.insert("adminAuditEvents", {
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action,
    subject,
    at: Date.now(),
    details,
  });
}

// -- who is looking -------------------------------------------------------

/**
 * Whether to render a link to `/admin`, and nothing more.
 *
 * Every admin read and write authorizes itself server-side. A client that
 * forces this to `true` gets a screen whose every query throws.
 */
export const amIAdmin = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => await viewerIsAdminHelper(ctx),
});

// -- the figures ----------------------------------------------------------

/**
 * How many rows a total may read before it becomes a floor.
 *
 * One page, sized so the common case is an exact number and the uncommon one
 * is a legible "10,000+" rather than a failed query.
 */
export const COUNT_CEILING = 10_000;

/**
 * The wire form of `CountedTotal`. See `structure.test.ts`: a public function
 * with no `returns:` hands the credential guard a schema of `"null"`, which it
 * reads and passes whatever the function actually returns.
 */
const countedTotalValidator = v.object({
  count: v.number(),
  isFloor: v.boolean(),
});

export interface CountedTotal {
  count: number;
  /** `true` when the ceiling was reached, so `count` is a floor. */
  isFloor: boolean;
}

async function countUpTo(
  ctx: { db: { query: (table: "workspaces" | "users") => { take: (n: number) => Promise<unknown[]> } } },
  table: "workspaces" | "users",
): Promise<CountedTotal> {
  // One more than the ceiling, so "exactly at the ceiling" and "more than the
  // ceiling" are distinguishable — reading exactly `COUNT_CEILING` rows and
  // reporting a floor would understate a number that happened to be exact.
  const rows = await ctx.db.query(table).take(COUNT_CEILING + 1);
  return rows.length > COUNT_CEILING
    ? { count: COUNT_CEILING, isFloor: true }
    : { count: rows.length, isFloor: false };
}

export interface MetricSeries {
  metric: string;
  /** One entry per day in the requested window, oldest first, zeroes included. */
  points: { day: string; count: number }[];
  total: number;
}

/**
 * Daily counters across the requested window.
 *
 * Zero-filled: a day with no rows reads `0` rather than being absent, because
 * a trend line with holes in it is read as missing data and a zero is a fact.
 *
 * The window is clamped (`clampReportDays`) so an argument cannot ask for a
 * full-table scan.
 */
export const usageReport = query({
  args: { days: v.optional(v.number()) },
  returns: v.object({
    days: v.number(),
    window: v.array(v.string()),
    series: v.array(
      v.object({
        metric: v.string(),
        points: v.array(v.object({ day: v.string(), count: v.number() })),
        total: v.number(),
      }),
    ),
    activeContexts: v.object({
      points: v.array(v.object({ day: v.string(), count: v.number() })),
      distinctInWindow: v.number(),
    }),
    totals: v.object({
      workspaces: countedTotalValidator,
      users: countedTotalValidator,
    }),
  }),
  handler: async (ctx, args) => {
    try {
      await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }

    const days = clampReportDays(args.days);
    const window = dayRange(dayKey(Date.now()), days);
    const inWindow = new Set(window);

    const series: MetricSeries[] = [];
    for (const metric of USAGE_METRICS) {
      const counts = new Map<string, number>(window.map((day) => [day, 0]));
      // Ranged on `by_metric_day` so the read is bounded by the window rather
      // than by how long the platform has been running.
      const rows = await ctx.db
        .query("usageDaily")
        .withIndex("by_metric_day", (q) =>
          q.eq("metric", metric).gte("day", window[0]).lte("day", window[window.length - 1]),
        )
        .collect();
      for (const row of rows) {
        if (!inWindow.has(row.day)) continue;
        counts.set(row.day, (counts.get(row.day) ?? 0) + row.count);
      }
      const points = window.map((day) => ({ day, count: counts.get(day) ?? 0 }));
      series.push({
        metric,
        points,
        total: points.reduce((sum, point) => sum + point.count, 0),
      });
    }

    // Active contexts are a cardinality, not a sum — see the schema comment on
    // `usageActiveDaily`. Counted per day over distinct workspaces, and again
    // over the whole window, because "active today" and "active this month"
    // are different questions and neither is derivable from the other.
    const activeByDay = new Map<string, Set<string>>(
      window.map((day) => [day, new Set<string>()]),
    );
    const activeInWindow = new Set<string>();
    for (const day of window) {
      const rows = await ctx.db
        .query("usageActiveDaily")
        .withIndex("by_day", (q) => q.eq("day", day))
        .collect();
      for (const row of rows) {
        activeByDay.get(day)?.add(row.workspaceId);
        activeInWindow.add(row.workspaceId);
      }
    }

    return {
      days,
      window,
      series,
      activeContexts: {
        points: window.map((day) => ({
          day,
          count: activeByDay.get(day)?.size ?? 0,
        })),
        distinctInWindow: activeInWindow.size,
      },
      // Totals that are facts about now rather than about the window.
      //
      // **Floors, not totals, and bounded reads.** `collect()` here was a full
      // table scan per page load: correct at today's size, and at a hundred
      // thousand accounts it is the admin page failing on Convex's per-query
      // document limit — the one screen whose job is to tell you the product
      // is growing, breaking because it did. There is no count API, so this
      // takes one page and says honestly when it filled it, which is the same
      // floor language `noteCount` and the census already use.
      totals: {
        workspaces: await countUpTo(ctx, "workspaces"),
        users: await countUpTo(ctx, "users"),
      },
    };
  },
});

// -- the secrets ----------------------------------------------------------

export interface AdminSecretRow {
  name: string;
  fingerprint: string;
  description?: string;
  updatedAt: number;
  createdAt: number;
  updatedByEmail?: string;
}

/**
 * Every stored integration credential, as metadata.
 *
 * `encryptedValue` is not selected, not decrypted, and not returned. The
 * envelope never leaves the database through this function — not even in its
 * sealed form, because a sealed envelope plus a leaked key is the credential,
 * and a ciphertext on a client is a ciphertext an attacker can keep.
 */
export const listSecrets = query({
  args: {},
  returns: v.array(
    v.object({
      name: v.string(),
      fingerprint: v.string(),
      description: v.optional(v.string()),
      updatedAt: v.number(),
      createdAt: v.number(),
      updatedByEmail: v.optional(v.string()),
    }),
  ),
  handler: async (ctx): Promise<AdminSecretRow[]> => {
    try {
      await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }

    const rows = await ctx.db.query("appSecrets").collect();
    rows.sort((a, b) => a.name.localeCompare(b.name));

    const out: AdminSecretRow[] = [];
    for (const row of rows) {
      const setter = await ctx.db.get(row.updatedBy);
      out.push({
        name: row.name,
        fingerprint: row.fingerprint,
        description: row.description,
        updatedAt: row.updatedAt,
        createdAt: row.createdAt,
        updatedByEmail: setter?.email,
      });
    }
    return out;
  },
});

/**
 * Store or replace one integration credential.
 *
 * An action rather than a mutation because `encryptSecret` draws a random IV,
 * which a Convex mutation may not do — the same split `bindStorage` uses for a
 * customer's storage key, and for the same reason.
 *
 * Replacing is deliberately the same call as creating. A separate "rotate"
 * path would be a second place for the envelope to be written, and the
 * difference an operator cares about — did this change, and to what — is the
 * fingerprint, which both paths recompute.
 */
export const setSecret = action({
  args: {
    name: v.string(),
    value: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.object({ name: v.string(), fingerprint: v.string() }),
  handler: async (ctx, args): Promise<{ name: string; fingerprint: string }> => {
    let actor: AdminActor;
    let name: string;
    let value: string;
    let description: string | undefined;
    try {
      // An action has no `ctx.db`, so the authorization is a query call. It is
      // still server-side and still the same predicate — `runQuery` of an
      // internal query that re-derives the identity from the request, never a
      // boolean the client passed in.
      actor = await ctx.runQuery(internal.functions.admin.requireAdminActor, {});
      name = normalizeSecretName(args.name);
      value = normalizeSecretValue(args.value);
      description = normalizeSecretDescription(args.description);
    } catch (error) {
      throw toConvexError(error);
    }

    const fingerprint = await fingerprintSecret(value);
    const envelope = await encryptSecret(value, requireKeyset(), {
      platform: "integration",
    });

    await ctx.runMutation(internal.functions.admin.applySecret, {
      actorUserId: actor.userId,
      actorEmail: actor.email,
      name,
      envelope,
      fingerprint,
      description,
    });

    return { name, fingerprint };
  },
});

export const deleteSecret = mutation({
  args: { name: v.string() },
  returns: v.object({ name: v.string() }),
  handler: async (ctx, args) => {
    let actor: AdminActor;
    let name: string;
    try {
      actor = await requireAdmin(ctx);
      name = normalizeSecretName(args.name);
    } catch (error) {
      throw toConvexError(error);
    }

    const row = await ctx.db
      .query("appSecrets")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (row === null) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: `No secret named ${name}.`,
      });
    }

    await ctx.db.delete(row._id);
    await recordAdminAudit(ctx, actor, "secret.deleted", name, {
      fingerprint: row.fingerprint,
    });
    return { name };
  },
});

// -- internals ------------------------------------------------------------

/**
 * The authorization an action cannot perform for itself.
 *
 * Internal, and it returns the actor rather than a boolean so the calling
 * action cannot proceed having merely *asked* whether the caller is staff.
 */
export const requireAdminActor = internalQuery({
  args: {},
  handler: async (ctx): Promise<AdminActor> => {
    try {
      return await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
  },
});

export const applySecret = internalMutation({
  args: {
    actorUserId: v.id("users"),
    actorEmail: v.string(),
    name: v.string(),
    envelope: v.string(),
    fingerprint: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("appSecrets")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();

    const actor: AdminActor = {
      userId: args.actorUserId,
      email: args.actorEmail,
    };

    if (existing === null) {
      await ctx.db.insert("appSecrets", {
        name: args.name,
        encryptedValue: args.envelope,
        fingerprint: args.fingerprint,
        description: args.description,
        updatedBy: args.actorUserId,
        updatedAt: now,
        createdAt: now,
      });
      await recordAdminAudit(ctx, actor, "secret.set", args.name, {
        fingerprint: args.fingerprint,
      });
      return;
    }

    await ctx.db.patch(existing._id, {
      encryptedValue: args.envelope,
      fingerprint: args.fingerprint,
      // An absent description leaves the existing one alone: the common edit
      // is rotating a value, and clearing the note explaining what a token is
      // for as a side effect of that would be a surprise.
      description: args.description ?? existing.description,
      updatedBy: args.actorUserId,
      updatedAt: now,
    });
    await recordAdminAudit(ctx, actor, "secret.updated", args.name, {
      fingerprint: args.fingerprint,
      previousFingerprint: existing.fingerprint,
    });
  },
});

export const secretEnvelope = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args): Promise<Doc<"appSecrets"> | null> =>
    await ctx.db
      .query("appSecrets")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique(),
});

/**
 * Open one integration credential, for the server code that uses it.
 *
 * **Internal, and it must stay internal.** `__tests__/structure.test.ts` walks
 * the call graph from every public function and fails if one reaches
 * `decryptSecret`; this is the reason that test covers this file. The D1
 * provisioner, the payment integration and the mail integration call it. A
 * screen never does.
 *
 * Returns `null` for an absent name rather than throwing, because "this
 * integration is not configured yet" is an ordinary state a caller should
 * handle with a clear message, not an exception it has to classify.
 */
export const readIntegrationSecret = internalAction({
  args: { name: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const name = normalizeSecretName(args.name);
    const row: Doc<"appSecrets"> | null = await ctx.runQuery(
      internal.functions.admin.secretEnvelope,
      { name },
    );
    if (row === null) return null;
    return await decryptSecret(row.encryptedValue, requireKeyset(), {
      platform: "integration",
    });
  },
});
