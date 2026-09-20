/**
 * THE CENSUS — `functions/lib/census.ts` and `functions/admin.ts:censusReport`.
 *
 * The staff dashboard's job is to say whether the product is growing, and the
 * failure that matters is not a crash. It is a figure that is quietly wrong
 * and looks fine, because nobody goes back to check a number they already
 * quoted. So these pin the specific ways a census lies:
 *
 *  - a cumulative curve that restarts at the left edge, which re-founds the
 *    company thirty days ago;
 *  - a bounded read reported as a total, which is the bug `noteCount` already
 *    has a decision written about;
 *  - managed storage counted as a customer's own bucket, or the reverse, which
 *    is the number that decides what we are paying for;
 *  - revenue counted from a declined card;
 *  - a funnel normalized into a monotonic staircase, which hides exactly the
 *    customer worth talking to.
 *
 * And the property every admin function has to have, restated for a new one:
 * it reaches across every tenant, so it refuses everybody who is not staff.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *
 *   `cumulativePerDay` counting only what falls inside the window       2
 *   `pageOf` reporting a filled page as exact                           3
 *   `mrrCents` counting `past_due` as paying                            1
 *   the managed test comparing on a prefix rather than the whole name   1
 *   `funnelOf` clamping each step to the one above it                   1
 *   `censusReport` losing its `requireAdmin`                            2
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { MANAGED_BUCKET_PREFIX } from "../functions/lib/managedStorage";
import { PREMIUM_PRICE_CENTS } from "../functions/lib/premium";
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
} from "../functions/lib/census";
import { dayKey, dayRange } from "../functions/lib/usage";

const ADMIN = "staff@example.test";
const DAY = 86_400_000;

/** A fixed clock, so a test never straddles a UTC midnight and flakes. */
const NOON = Date.parse("2026-09-14T12:00:00.000Z");

function at(daysAgo: number): number {
  return NOON - daysAgo * DAY;
}

// -- the arithmetic -------------------------------------------------------

describe("added per day", () => {
  const window = dayRange("2026-09-14", 3); // 12th, 13th, 14th

  test("buckets by UTC date and zero-fills", () => {
    expect(addedPerDay([at(0), at(0), at(2)], window)).toEqual([
      { day: "2026-09-12", count: 1 },
      { day: "2026-09-13", count: 0 },
      { day: "2026-09-14", count: 2 },
    ]);
  });

  test("anything outside the window is not counted", () => {
    expect(addedPerDay([at(40)], window).map((p) => p.count)).toEqual([0, 0, 0]);
  });
});

describe("cumulative per day", () => {
  const window = dayRange("2026-09-14", 3);

  test("counts everything created on or before each day, window or not", () => {
    // The one that matters. Two accounts predate the window entirely; a curve
    // that starts at zero here says the product was founded three days ago.
    expect(cumulativePerDay([at(400), at(300), at(1)], window)).toEqual([
      { day: "2026-09-12", count: 2 },
      { day: "2026-09-13", count: 3 },
      { day: "2026-09-14", count: 3 },
    ]);
  });

  test("is monotonic, and unaffected by the order rows arrive in", () => {
    const shuffled = [at(1), at(400), at(0), at(300)];
    const points = cumulativePerDay(shuffled, window).map((p) => p.count);
    expect(points).toEqual([2, 3, 4]);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]).toBeGreaterThanOrEqual(points[i - 1]);
    }
  });

  test("no rows is a flat zero rather than an empty chart", () => {
    expect(cumulativePerDay([], window).map((p) => p.count)).toEqual([0, 0, 0]);
  });
});

describe("the window before this one", () => {
  test("is the same length, and ends the day before", () => {
    const window = dayRange("2026-09-14", 7);
    const prior = priorWindow(window);
    expect(prior).toHaveLength(7);
    expect(prior[prior.length - 1]).toBe("2026-09-07");
    expect(prior[0]).toBe("2026-09-01");
    // No overlap, or "new this week" would count some days twice.
    expect(prior.some((day) => window.includes(day))).toBe(false);
  });

  test("an empty window has no prior", () => {
    expect(priorWindow([])).toEqual([]);
  });

  test("counting inside a window is inclusive at both ends", () => {
    const window = dayRange("2026-09-14", 3);
    expect(countInWindow([at(2), at(0)], window)).toBe(2);
    expect(countInWindow([at(3)], window)).toBe(0);
  });
});

describe("bounded pages", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

  test("a page that did not fill is exact", () => {
    const page = pageOf(rows(4), 10);
    expect(page.isFloor).toBe(false);
    expect(totalOf(page)).toEqual({ count: 4, isFloor: false });
  });

  test("exactly at the ceiling is still exact", () => {
    // The off-by-one worth pinning: callers take `ceiling + 1`, so a page of
    // exactly `ceiling` rows means the table held exactly that many.
    const page = pageOf(rows(10), 10);
    expect(totalOf(page)).toEqual({ count: 10, isFloor: false });
  });

  test("one row past the ceiling is a floor, and the extra is dropped", () => {
    const page = pageOf(rows(11), 10);
    expect(page.rows).toHaveLength(10);
    expect(totalOf(page)).toEqual({ count: 10, isFloor: true });
  });

  test("the ceiling is low on purpose", () => {
    // Not a tuning knob — see the constant's own comment. If somebody raises
    // it, this is where they have to think about the per-query byte limit.
    expect(CENSUS_CEILING).toBeLessThanOrEqual(1_000);
  });
});

describe("revenue", () => {
  test("is derived from the one price, not a second copy of it", () => {
    expect(mrrCents(3)).toBe(3 * PREMIUM_PRICE_CENTS);
    expect(mrrCents(0)).toBe(0);
  });

  test("cannot go negative", () => {
    expect(mrrCents(-2)).toBe(0);
  });
});

describe("ratios", () => {
  test("one decimal", () => {
    expect(perCapita(11, 7)).toBe(1.6);
  });

  test("nothing to divide by is null, never zero", () => {
    // "no accounts yet" and "every account has no context" are different
    // facts, and the screen draws them differently.
    expect(perCapita(0, 0)).toBeNull();
    expect(perCapita(4, 0)).toBeNull();
    expect(perCapita(0, 4)).toBe(0);
  });
});

describe("tallies", () => {
  test("largest first, ties broken by key so the order never flickers", () => {
    expect(tally(["s3", "r2", "r2", "b2", "s3", "r2"])).toEqual([
      { key: "r2", count: 3 },
      { key: "s3", count: 2 },
      { key: "b2", count: 1 },
    ]);
  });
});

describe("the funnel", () => {
  const account = (over: Partial<Record<string, boolean>> = {}) => ({
    hasContext: false,
    hasConnectedStorage: false,
    hasActiveClient: false,
    isPaying: false,
    ...over,
  });

  test("counts each threshold independently", () => {
    const rows = funnelOf([
      account({ hasContext: true, hasConnectedStorage: true, isPaying: true }),
      account({ hasContext: true }),
      account(),
    ]);
    expect(rows).toEqual([
      { step: "signed-up", count: 3 },
      { step: "made-a-context", count: 2 },
      { step: "connected-storage", count: 1 },
      { step: "connected-a-client", count: 0 },
      { step: "paying", count: 1 },
    ]);
  });

  test("a later step may exceed an earlier one, and is not clamped", () => {
    // Somebody whose client is connected to a context whose bucket never
    // verified. That is the customer to go and talk to; a staircase that
    // clamped `connected-a-client` down to `connected-storage` would erase
    // them from the one screen that could have shown them.
    const rows = funnelOf([account({ hasContext: true, hasActiveClient: true })]);
    const byStep = new Map(rows.map((row) => [row.step, row.count]));
    expect(byStep.get("connected-storage")).toBe(0);
    expect(byStep.get("connected-a-client")).toBe(1);
  });
});

describe("the strongest plan an account holds", () => {
  test("a paying context outranks the free ones beside it", () => {
    expect(strongestPlan(["none", "active", "canceled"])).toBe("active");
  });

  test("owning nothing is none", () => {
    expect(strongestPlan([])).toBe("none");
  });

  test("a declined card outranks a cancellation but not a payment", () => {
    expect(strongestPlan(["canceled", "past_due"])).toBe("past_due");
    expect(strongestPlan(["past_due", "active"])).toBe("active");
  });
});

// -- the query ------------------------------------------------------------

type Harness = ReturnType<typeof convexTest>;

async function seedUser(t: Harness, email: string): Promise<Id<"users">> {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("users", {
        email,
        emailVerificationTime: Date.now(),
      } as never),
  );
}

async function seedContext(
  t: Harness,
  owner: Id<"users">,
  slug: string,
  kind: "personal" | "shared",
  createdAt: number = NOON,
): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug,
      displayName: slug,
      createdBy: owner,
      kind,
      structureTemplate: "para",
      createdAt,
      updatedAt: createdAt,
    });
    await ctx.db.insert("workspaceMembers", {
      workspaceId,
      userId: owner,
      role: "owner",
      joinedAt: createdAt,
    });
    return workspaceId;
  });
}

async function bind(
  t: Harness,
  workspaceId: Id<"workspaces">,
  owner: Id<"users">,
  bucket: string,
  status: "connected" | "unverified" | "error" = "connected",
  provider: "r2" | "s3" | "dropbox" = "r2",
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("storageBindings", {
      workspaceId,
      provider,
      bucket,
      capabilities: { conditionalWrite: true },
      status,
      boundBy: owner,
      createdAt: NOON,
      updatedAt: NOON,
    });
  });
}

async function plan(
  t: Harness,
  workspaceId: Id<"workspaces">,
  status: "active" | "past_due" | "canceled",
  selection: { managedStorage: boolean; fastSearch: boolean } = {
    managedStorage: true,
    fastSearch: false,
  },
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("workspacePlans", {
      workspaceId,
      ...selection,
      status,
      createdAt: NOON,
      updatedAt: NOON,
    });
  });
}

async function grant(
  t: Harness,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  clientId: string,
  status: "active" | "revoked" = "active",
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId,
      scopes: ["context:read"],
      hashedRefreshToken: `hash-${clientId}-${String(workspaceId)}-${status}`,
      status,
      lastUsedAt: NOON,
      createdAt: NOON,
    });
  });
}

async function staff(t: Harness) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const userId = await seedUser(t, ADMIN);
  return { userId, as: t.withIdentity({ subject: userId }) };
}

describe("the census refuses everyone who is not staff", () => {
  test("signed out, and signed in as a stranger", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    await expect(t.query(api.functions.admin.censusReport, {})).rejects.toThrow();

    const strangerId = await seedUser(t, "someone@example.test");
    await expect(
      t.withIdentity({ subject: strangerId }).query(api.functions.admin.censusReport, {}),
    ).rejects.toThrow();
  });
});

describe("the census counts the estate", () => {
  test("contexts outnumber accounts, and the ratio says so", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await staff(t);
    const second = await seedUser(t, "second@example.test");
    await seedContext(t, userId, "one", "personal");
    await seedContext(t, userId, "two", "shared");
    await seedContext(t, second, "three", "personal");

    const report = await as.query(api.functions.admin.censusReport, {});
    expect(report.accounts.total).toEqual({ count: 2, isFloor: false });
    expect(report.contexts.total).toEqual({ count: 3, isFloor: false });
    expect(report.contexts.personal).toBe(2);
    expect(report.contexts.shared).toBe(1);
    expect(report.contexts.perAccount).toBe(1.5);
  });

  test("a managed bucket and a customer's own are told apart by the whole name", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await staff(t);
    const ours = await seedContext(t, userId, "ours", "personal");
    const theirs = await seedContext(t, userId, "theirs", "personal");
    const lookalike = await seedContext(t, userId, "lookalike", "personal");

    await bind(t, ours, userId, `${MANAGED_BUCKET_PREFIX}${String(ours)}`);
    await bind(t, theirs, userId, "my-own-notes", "connected", "s3");
    // Our prefix, somebody else's id: a bucket we do not run. Comparing on the
    // prefix alone would count this as ours and overstate what we pay for.
    await bind(t, lookalike, userId, `${MANAGED_BUCKET_PREFIX}${String(theirs)}`);

    const report = await as.query(api.functions.admin.censusReport, {});
    expect(report.storage.managed).toBe(1);
    expect(report.storage.customer).toBe(2);
    expect(report.storage.unbound).toBe(0);
    expect(report.storage.byProvider).toEqual([
      { provider: "r2", managed: 1, customer: 1 },
      { provider: "s3", managed: 0, customer: 1 },
    ]);
  });

  test("a context with no binding is counted as unbound, not as a customer's", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await staff(t);
    await seedContext(t, userId, "empty", "personal");

    const report = await as.query(api.functions.admin.censusReport, {});
    expect(report.storage).toMatchObject({ managed: 0, customer: 0, unbound: 1 });
  });

  test("revenue counts paying contexts and not declined cards", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await staff(t);
    const paid = await seedContext(t, userId, "paid", "personal");
    const lapsed = await seedContext(t, userId, "lapsed", "personal");
    const gone = await seedContext(t, userId, "gone", "personal");
    await seedContext(t, userId, "free", "personal");

    await plan(t, paid, "active", { managedStorage: true, fastSearch: true });
    await plan(t, lapsed, "past_due", { managedStorage: true, fastSearch: true });
    await plan(t, gone, "canceled");

    const report = await as.query(api.functions.admin.censusReport, {});
    expect(report.plans).toMatchObject({
      paying: 1,
      pastDue: 1,
      canceled: 1,
      free: 1,
      mrrCents: PREMIUM_PRICE_CENTS,
    });
    // What is *served*, which is the selection ANDed with paying. The lapsed
    // context selected both and gets neither.
    expect(report.plans.servingManagedStorage).toBe(1);
    expect(report.plans.servingFastSearch).toBe(1);
  });

  test("connection sources are grouped by client, with revoked grants kept apart", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await staff(t);
    const one = await seedContext(t, userId, "one", "personal");
    const two = await seedContext(t, userId, "two", "shared");
    await t.run(async (ctx) => {
      await ctx.db.insert("oauthClients", {
        clientId: "cid-desk",
        clientName: "A Desktop Client",
        redirectUris: ["http://127.0.0.1/callback"],
        hashedClientSecret: null,
        createdAt: NOON,
      });
    });
    await grant(t, one, userId, "cid-desk");
    await grant(t, two, userId, "cid-desk");
    await grant(t, one, userId, "cid-desk", "revoked");
    await grant(t, one, userId, "cid-unregistered");

    const report = await as.query(api.functions.admin.censusReport, {});
    expect(report.clients).toEqual([
      {
        clientId: "cid-desk",
        clientName: "A Desktop Client",
        active: 2,
        revoked: 1,
        contexts: 2,
        accounts: 1,
        lastUsedAt: NOON,
      },
      {
        clientId: "cid-unregistered",
        // No registration row, so the id stands in rather than a blank cell.
        clientName: "cid-unregistered",
        active: 1,
        revoked: 0,
        contexts: 1,
        accounts: 1,
        lastUsedAt: NOON,
      },
    ]);
  });

  test("the growth curve reaches back past the window", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await staff(t);
    /*
      SEEDED AGAINST THE REAL CLOCK, not the fixture noon the rest of this file
      uses. `censusReport` builds its window from `Date.now()` (admin.ts), so a
      fixture pinned to a fixed date only stays inside a seven-day window while
      the real date is near it: this test passed until 2026-09-18 and failed
      from 2026-09-19, when the window's first day became the day the "new"
      context was seeded and the curve started at 2 rather than 1.

      A date-dependent test is one that eventually reports a defect nobody
      introduced, on a day nobody chose — so the offsets are what this test is
      actually about (one context older than the window, one inside it but not
      on its first day) rather than dates that happen to satisfy that today.
    */
    const now = Date.now();
    await seedContext(t, userId, "old", "personal", now - 200 * DAY);
    await seedContext(t, userId, "new", "personal", now - 1 * DAY);

    const report = await as.query(api.functions.admin.censusReport, { days: 7 });
    const curve = report.contexts.cumulative;
    expect(curve).toHaveLength(7);
    // The old context is already there on day one of the window.
    expect(curve[0].count).toBe(1);
    expect(curve[curve.length - 1].count).toBe(2);
    expect(report.contexts.newInWindow).toBe(1);
  });

  test("the funnel and the roster describe the same accounts", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await staff(t);
    const stalled = await seedUser(t, "stalled@example.test");
    await seedUser(t, "never-started@example.test");

    const mine = await seedContext(t, userId, "mine", "personal");
    await bind(t, mine, userId, `${MANAGED_BUCKET_PREFIX}${String(mine)}`);
    await plan(t, mine, "active");
    await grant(t, mine, userId, "cid-desk");
    // An account with a context whose bucket never verified.
    const theirs = await seedContext(t, stalled, "theirs", "personal");
    await bind(t, theirs, stalled, "half-built", "error", "s3");

    const report = await as.query(api.functions.admin.censusReport, {});
    expect(report.funnel).toEqual([
      { step: "signed-up", count: 3 },
      { step: "made-a-context", count: 2 },
      { step: "connected-storage", count: 1 },
      { step: "connected-a-client", count: 1 },
      { step: "paying", count: 1 },
    ]);

    const byEmail = new Map(report.roster.map((row) => [row.email, row]));
    expect(byEmail.get(ADMIN)).toMatchObject({
      contexts: 1,
      owned: 1,
      connectedStorage: 1,
      clients: 1,
      plan: "active",
    });
    expect(byEmail.get("stalled@example.test")).toMatchObject({
      owned: 1,
      connectedStorage: 0,
      clients: 0,
      plan: "none",
    });
    expect(byEmail.get("never-started@example.test")).toMatchObject({
      contexts: 0,
      owned: 0,
      plan: "none",
    });
  });

  test("an empty deployment reports zeroes rather than failing", async () => {
    const t = convexTest(schema, modules);
    const { as } = await staff(t);
    const report = await as.query(api.functions.admin.censusReport, {});
    expect(report.truncated).toBe(false);
    expect(report.clients).toEqual([]);
    expect(report.contexts.total).toEqual({ count: 0, isFloor: false });
    expect(report.contexts.perAccount).toBe(0);
    expect(report.contexts.membersPerShared).toBeNull();
    expect(report.plans.mrrCents).toBe(0);
    // Every day of the window is present as a zero, so the screen draws a flat
    // line rather than an absence it has to explain.
    expect(report.accounts.cumulative).toHaveLength(report.days);
  });

  test("the window is clamped, exactly as the usage report's is", async () => {
    const t = convexTest(schema, modules);
    const { as } = await staff(t);
    const report = await as.query(api.functions.admin.censusReport, {
      days: 100_000,
    });
    expect(report.days).toBe(90);
    expect(report.window).toHaveLength(90);
    expect(report.window[report.window.length - 1]).toBe(dayKey(Date.now()));
  });
});
