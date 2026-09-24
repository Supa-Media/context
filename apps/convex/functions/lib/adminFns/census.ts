/**
 * The handler for `admin.censusReport`, and the validators it needs.
 *
 * Split out of `functions/admin.ts` — see that file's header for the
 * credential-boundary rule this whole module exists under, and see
 * `censusReport`'s own doc comment there for why this is separate from
 * `usageReport` and why every figure here is a floor when the page filled.
 */

import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
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
} from "../census";
import { managedBucketName } from "../managedStorage";
import { activeEntitlements, type PlanStatus } from "../premium";
import { clampReportDays, dayKey, dayRange } from "../usage";
import { countedTotalValidator } from "./usage";

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
export const populationValidator = {
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
export async function censusReportHandler(ctx: QueryCtx, args: { days?: number }) {
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
      binding.bucket === managedBucketName(binding.workspaceId);
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
}
