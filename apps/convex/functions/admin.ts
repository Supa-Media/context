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
import {
  CENSUS_CEILING,
  addedPerDay,
  countInWindow,
  cumulativePerDay,
  funnelOf,
  mrrCents,
  pageOf,
  perCapita,
  priorWindow,
  strongestPlan,
  tally,
  totalOf,
  type AccountFacts,
} from "./lib/census";
import { decryptSecret, encryptSecret, requireKeyset } from "./lib/crypto";
import { MANAGED_BUCKET_PREFIX } from "./lib/managedStorage";
import { activeEntitlements, type PlanStatus } from "./lib/premium";
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

// -- the census -----------------------------------------------------------

/**
 * How many accounts the roster names.
 *
 * A list, not a table dump: at the size this screen is designed for, the
 * newest fifty accounts *is* everybody, and past that the question the roster
 * answers ("who arrived, and did they get anywhere") is still about the newest
 * arrivals. It bounds the returned payload as a side effect, which is the
 * lesser reason.
 */
export const ROSTER_LIMIT = 50;

/**
 * How much of a client's self-declared name is kept.
 *
 * `oauthClients.clientName` is **client-asserted**: RFC 7591 registration is
 * unauthenticated by construction, so anything that can register can call
 * itself anything, including a thousand characters of it. This screen renders
 * that string, so it is truncated here rather than trusted to a layout.
 */
const MAX_CLIENT_NAME = 64;

const pointValidator = v.object({ day: v.string(), count: v.number() });

/** The growth of one population: what exists, what arrived, and when. */
const populationValidator = {
  total: countedTotalValidator,
  added: v.array(pointValidator),
  cumulative: v.array(pointValidator),
  newInWindow: v.number(),
  newInPriorWindow: v.number(),
};

function keyOf(id: Id<"workspaces"> | Id<"users">): string {
  return String(id);
}

/** Add one to a counter held in a map, creating it at zero first. */
function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * The platform census: who is here, what they built, and what we run for them.
 *
 * ## Why this is not part of `usageReport`
 *
 * They answer different questions from different evidence. `usageReport` reads
 * `usageDaily` — events, counted from the day somebody added the counter, and
 * therefore blind to everything before that. This counts **rows that exist
 * now** and buckets them by when they were created, which makes every figure
 * retroactive and exact. A growth curve that begins on the day the counter
 * shipped is not a growth curve.
 *
 * Separate subscriptions also mean one can be slow or fail without taking the
 * other's section of the screen with it.
 *
 * ## Every figure here is a floor when the page filled
 *
 * Each read is one bounded page (`CENSUS_CEILING`), and `truncated` is the OR
 * of all of them. It travels to the client because the honest rendering
 * changes: totals print as `500+`, and the **trend curves are withheld
 * entirely** rather than drawn from a partial page. A cumulative line missing
 * an arbitrary slice of its rows is not a less precise chart, it is a
 * different and wrong shape — the same reasoning `noteCount` records for
 * refusing to print a floor as a total.
 *
 * Rows are taken newest-first so a truncated page holds the recent end, which
 * is the half a census is asked about.
 *
 * ## Still metadata only
 *
 * Accounts, contexts, bindings, plans, grants. Nothing per-note, per-path or
 * per-query — the standing rule in this file's header, which this function is
 * the largest single temptation to break.
 */
export const censusReport = query({
  args: { days: v.optional(v.number()) },
  returns: v.object({
    days: v.number(),
    window: v.array(v.string()),
    truncated: v.boolean(),
    accounts: v.object(populationValidator),
    contexts: v.object({
      ...populationValidator,
      personal: v.number(),
      shared: v.number(),
      perAccount: v.union(v.number(), v.null()),
      membersPerShared: v.union(v.number(), v.null()),
    }),
    storage: v.object({
      managed: v.number(),
      customer: v.number(),
      unbound: v.number(),
      byProvider: v.array(
        v.object({
          provider: v.string(),
          managed: v.number(),
          customer: v.number(),
        }),
      ),
      byStatus: v.array(v.object({ status: v.string(), count: v.number() })),
    }),
    plans: v.object({
      paying: v.number(),
      pastDue: v.number(),
      canceled: v.number(),
      unresolved: v.number(),
      free: v.number(),
      mrrCents: v.number(),
      servingManagedStorage: v.number(),
      servingFastSearch: v.number(),
      provisioningRunning: v.number(),
      provisioningFailed: v.number(),
    }),
    clients: v.array(
      v.object({
        clientId: v.string(),
        clientName: v.string(),
        active: v.number(),
        revoked: v.number(),
        contexts: v.number(),
        accounts: v.number(),
        lastUsedAt: v.union(v.number(), v.null()),
      }),
    ),
    sources: v.object({
      googleAccounts: v.number(),
      gmail: v.number(),
      calendar: v.number(),
      chat: v.number(),
      dropbox: v.number(),
      mailOpen: v.number(),
      mailAllowlisted: v.number(),
      obsidian: v.number(),
    }),
    funnel: v.array(v.object({ step: v.string(), count: v.number() })),
    roster: v.array(
      v.object({
        joinedAt: v.number(),
        email: v.optional(v.string()),
        contexts: v.number(),
        owned: v.number(),
        connectedStorage: v.number(),
        clients: v.number(),
        plan: v.string(),
        lastSeenAt: v.union(v.number(), v.null()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    try {
      await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }

    const days = clampReportDays(args.days);
    const window = dayRange(dayKey(Date.now()), days);
    const prior = priorWindow(window);
    const take = CENSUS_CEILING + 1;

    // Newest first, for the reason the doc comment gives: a page that fills
    // should drop the oldest rows, not the ones being asked about.
    const accountsPage = pageOf(await ctx.db.query("users").order("desc").take(take));
    const contextsPage = pageOf(
      await ctx.db.query("workspaces").order("desc").take(take),
    );
    const membersPage = pageOf(await ctx.db.query("workspaceMembers").take(take));
    const bindingsPage = pageOf(await ctx.db.query("storageBindings").take(take));
    const plansPage = pageOf(await ctx.db.query("workspacePlans").take(take));
    const grantsPage = pageOf(await ctx.db.query("oauthGrants").take(take));
    const clientsPage = pageOf(await ctx.db.query("oauthClients").take(take));
    const googlePage = pageOf(await ctx.db.query("googleConnections").take(take));
    const mailPage = pageOf(await ctx.db.query("ingestionSettings").take(take));
    const pluginsPage = pageOf(
      await ctx.db.query("obsidianPluginGrants").take(take),
    );

    const truncated = [
      accountsPage,
      contextsPage,
      membersPage,
      bindingsPage,
      plansPage,
      grantsPage,
      clientsPage,
      googlePage,
      mailPage,
      pluginsPage,
    ].some((page) => page.isFloor);

    // -- the two populations, over time ------------------------------------

    const accountCreated = accountsPage.rows.map((row) => row._creationTime);
    const contextCreated = contextsPage.rows.map((row) => row.createdAt);

    const personal = contextsPage.rows.filter((row) => row.kind === "personal");
    const shared = contextsPage.rows.filter((row) => row.kind === "shared");

    const sharedIds = new Set(shared.map((row) => keyOf(row._id)));
    const membersInShared = membersPage.rows.filter((row) =>
      sharedIds.has(keyOf(row.workspaceId)),
    ).length;

    // -- storage: whose bucket is it ---------------------------------------

    const boundContexts = new Set<string>();
    const providerCounts = new Map<string, { managed: number; customer: number }>();
    const statusCounts = new Map<string, number>();
    let managed = 0;
    let customer = 0;
    let dropbox = 0;

    for (const binding of bindingsPage.rows) {
      boundContexts.add(keyOf(binding.workspaceId));
      // Derived from the bucket's name rather than from a flag, exactly as
      // `functions/billing.ts` derives it. The prefix is interpolated here
      // rather than calling `managedBucketName`, which *throws* on a name it
      // cannot derive — correct when provisioning a bucket, wrong in a census,
      // where one unusual row must not take the whole dashboard down.
      const isManaged =
        binding.bucket === `${MANAGED_BUCKET_PREFIX}${String(binding.workspaceId)}`;
      if (isManaged) managed += 1;
      else customer += 1;
      if (binding.provider === "dropbox") dropbox += 1;

      const slot = providerCounts.get(binding.provider) ?? { managed: 0, customer: 0 };
      if (isManaged) slot.managed += 1;
      else slot.customer += 1;
      providerCounts.set(binding.provider, slot);
      bump(statusCounts, binding.status);
    }

    const connectedContexts = new Set(
      bindingsPage.rows
        .filter((binding) => binding.status === "connected")
        .map((binding) => keyOf(binding.workspaceId)),
    );

    // -- plans: who is paying, and for what --------------------------------

    const planByContext = new Map<string, PlanStatus>();
    let paying = 0;
    let pastDue = 0;
    let canceled = 0;
    let unresolved = 0;
    let servingManagedStorage = 0;
    let servingFastSearch = 0;
    let provisioningRunning = 0;
    let provisioningFailed = 0;

    for (const plan of plansPage.rows) {
      planByContext.set(keyOf(plan.workspaceId), plan.status);
      if (plan.status === "active") paying += 1;
      else if (plan.status === "past_due") pastDue += 1;
      else if (plan.status === "canceled") canceled += 1;
      else if (plan.status === "unknown") unresolved += 1;
      // What is actually being *served*, which is the selection ANDed with
      // paying — never the selection alone, which is what somebody asked for.
      const serving = activeEntitlements(
        { managedStorage: plan.managedStorage, fastSearch: plan.fastSearch },
        plan.status,
      );
      if (serving.managedStorage) servingManagedStorage += 1;
      if (serving.fastSearch) servingFastSearch += 1;
      if (plan.managedProvisioning === "running") provisioningRunning += 1;
      if (plan.managedProvisioning === "failed") provisioningFailed += 1;
    }

    const payingContexts = new Set(
      plansPage.rows
        .filter((plan) => plan.status === "active")
        .map((plan) => keyOf(plan.workspaceId)),
    );

    // -- connection sources: which clients are connected -------------------

    const clientNames = new Map(
      clientsPage.rows.map((row) => [
        row.clientId,
        row.clientName.slice(0, MAX_CLIENT_NAME),
      ]),
    );
    interface ClientTally {
      clientId: string;
      active: number;
      revoked: number;
      contexts: Set<string>;
      accounts: Set<string>;
      lastUsedAt: number | null;
    }
    const byClient = new Map<string, ClientTally>();
    const accountsWithClient = new Set<string>();
    const lastSeenByAccount = new Map<string, number>();

    for (const grant of grantsPage.rows) {
      let tally = byClient.get(grant.clientId);
      if (tally === undefined) {
        tally = {
          clientId: grant.clientId,
          active: 0,
          revoked: 0,
          contexts: new Set(),
          accounts: new Set(),
          lastUsedAt: null,
        };
        byClient.set(grant.clientId, tally);
      }
      if (grant.status === "active") {
        tally.active += 1;
        tally.contexts.add(keyOf(grant.workspaceId));
        tally.accounts.add(keyOf(grant.userId));
        accountsWithClient.add(keyOf(grant.userId));
      } else {
        tally.revoked += 1;
      }
      if (typeof grant.lastUsedAt === "number") {
        tally.lastUsedAt = Math.max(tally.lastUsedAt ?? 0, grant.lastUsedAt);
        const account = keyOf(grant.userId);
        lastSeenByAccount.set(
          account,
          Math.max(lastSeenByAccount.get(account) ?? 0, grant.lastUsedAt),
        );
      }
    }

    const clients = [...byClient.values()]
      .map((tally) => ({
        clientId: tally.clientId,
        clientName: clientNames.get(tally.clientId) ?? tally.clientId,
        active: tally.active,
        revoked: tally.revoked,
        contexts: tally.contexts.size,
        accounts: tally.accounts.size,
        lastUsedAt: tally.lastUsedAt,
      }))
      .sort(
        (a, b) =>
          b.active - a.active ||
          b.contexts - a.contexts ||
          a.clientName.localeCompare(b.clientName),
      );

    // -- the other capture surfaces ----------------------------------------

    const googleProducts = googlePage.rows.flatMap((row) => row.products);
    const obsidian = new Set(
      pluginsPage.rows
        .filter((row) => row.status === "active")
        .map((row) => keyOf(row.workspaceId)),
    );

    // -- per account: the funnel, and the roster ---------------------------

    const membershipsByAccount = new Map<string, number>();
    const ownedByAccount = new Map<string, Id<"workspaces">[]>();
    for (const member of membersPage.rows) {
      const account = keyOf(member.userId);
      bump(membershipsByAccount, account);
      if (member.role !== "owner") continue;
      const owned = ownedByAccount.get(account) ?? [];
      owned.push(member.workspaceId);
      ownedByAccount.set(account, owned);
    }

    const facts: AccountFacts[] = [];
    const roster: {
      joinedAt: number;
      email?: string;
      contexts: number;
      owned: number;
      connectedStorage: number;
      clients: number;
      plan: string;
      lastSeenAt: number | null;
    }[] = [];

    for (const account of accountsPage.rows) {
      const key = keyOf(account._id);
      const owned = ownedByAccount.get(key) ?? [];
      const ownedKeys = owned.map(keyOf);
      const connectedStorage = ownedKeys.filter((id) =>
        connectedContexts.has(id),
      ).length;
      const isPaying = ownedKeys.some((id) => payingContexts.has(id));
      const clientGrants = [...byClient.values()].filter((tally) =>
        tally.accounts.has(key),
      ).length;

      facts.push({
        hasContext: (membershipsByAccount.get(key) ?? 0) > 0,
        hasConnectedStorage: connectedStorage > 0,
        hasActiveClient: accountsWithClient.has(key),
        isPaying,
      });

      if (roster.length < ROSTER_LIMIT) {
        roster.push({
          joinedAt: account._creationTime,
          email: account.email,
          contexts: membershipsByAccount.get(key) ?? 0,
          owned: owned.length,
          connectedStorage,
          clients: clientGrants,
          plan: strongestPlan(
            ownedKeys.map((id) => planByContext.get(id) ?? "none"),
          ),
          lastSeenAt: lastSeenByAccount.get(key) ?? null,
        });
      }
    }

    return {
      days,
      window,
      truncated,
      accounts: {
        total: totalOf(accountsPage),
        added: addedPerDay(accountCreated, window),
        cumulative: cumulativePerDay(accountCreated, window),
        newInWindow: countInWindow(accountCreated, window),
        newInPriorWindow: countInWindow(accountCreated, prior),
      },
      contexts: {
        total: totalOf(contextsPage),
        added: addedPerDay(contextCreated, window),
        cumulative: cumulativePerDay(contextCreated, window),
        newInWindow: countInWindow(contextCreated, window),
        newInPriorWindow: countInWindow(contextCreated, prior),
        personal: personal.length,
        shared: shared.length,
        perAccount: perCapita(contextsPage.rows.length, accountsPage.rows.length),
        membersPerShared: perCapita(membersInShared, shared.length),
      },
      storage: {
        managed,
        customer,
        // Contexts with no binding at all — the step of the funnel that is
        // invisible from the bindings table, because it is an absence.
        unbound: contextsPage.rows.filter(
          (row) => !boundContexts.has(keyOf(row._id)),
        ).length,
        byProvider: [...providerCounts.entries()]
          .map(([provider, slot]) => ({ provider, ...slot }))
          .sort(
            (a, b) =>
              b.managed + b.customer - (a.managed + a.customer) ||
              a.provider.localeCompare(b.provider),
          ),
        byStatus: tally(bindingsPage.rows.map((row) => row.status)).map(
          ({ key, count }) => ({ status: key, count }),
        ),
      },
      plans: {
        paying,
        pastDue,
        canceled,
        unresolved,
        // Contexts nobody has ever opened a subscription for. A plan row that
        // exists but is not paying is counted under its own status, never
        // here: "free" and "lapsed" are different customers.
        free: contextsPage.rows.filter(
          (row) => !planByContext.has(keyOf(row._id)),
        ).length,
        mrrCents: mrrCents(paying),
        servingManagedStorage,
        servingFastSearch,
        provisioningRunning,
        provisioningFailed,
      },
      clients,
      sources: {
        googleAccounts: googlePage.rows.length,
        gmail: googleProducts.filter((product) => product === "gmail").length,
        calendar: googleProducts.filter((product) => product === "calendar").length,
        chat: googleProducts.filter((product) => product === "chat").length,
        dropbox,
        mailOpen: mailPage.rows.filter((row) => row.allowAnySender).length,
        mailAllowlisted: mailPage.rows.filter(
          (row) =>
            !row.allowAnySender &&
            (row.allowedSenders.length > 0 || row.allowedDomains.length > 0),
        ).length,
        obsidian: obsidian.size,
      },
      funnel: funnelOf(facts),
      roster,
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
