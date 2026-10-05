/**
 * THE ROSTER'S AI COLUMN — `functions/lib/jev/spend.ts`, read by
 * `admin.censusReport`.
 *
 * Jev usage is metered per (day, feature, workspace), not per person, so an
 * account's spend is the sum over the workspaces it **owns**, inside the
 * census window. These pin the ways that sum lies: a workspace the account is
 * merely a member of charged to it, a day outside the window counted, one
 * feature's rows dropped, and a read that hit its budget printed as exact.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *
 *   summing every membership rather than owned workspaces             1
 *   dropping the window's lower bound                                 1
 *   `censusReport` losing its `requireAdmin`                          1
 *   a budget-exhausted read not marked partial                        1
 */

import { afterEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { utcDay } from "../functions/lib/jev/meter";
import { aiSpendByWorkspace } from "../functions/lib/jev/spend";

const ADMIN = "staff@example.test";
const DAY = 86_400_000;

type Harness = ReturnType<typeof convexTest>;

afterEach(() => {
  delete process.env[ADMIN_EMAILS_ENV_VAR];
});

async function seedUser(t: Harness, email: string): Promise<Id<"users">> {
  return await t.run(
    async (ctx) => await ctx.db.insert("users", { email, emailVerificationTime: Date.now() } as never),
  );
}

async function seedWorkspace(
  t: Harness,
  owner: Id<"users">,
  slug: string,
  members: Id<"users">[] = [],
): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      slug,
      displayName: slug,
      createdBy: owner,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", { workspaceId, userId: owner, role: "owner", joinedAt: now });
    for (const userId of members) {
      await ctx.db.insert("workspaceMembers", { workspaceId, userId, role: "member", joinedAt: now });
    }
    return workspaceId;
  });
}

async function spend(
  t: Harness,
  workspaceId: Id<"workspaces">,
  feature: string,
  costMicroUsd: number,
  daysAgo = 0,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("jevUsage", {
      day: utcDay(Date.now() - daysAgo * DAY),
      feature,
      workspaceId,
      calls: 1,
      failed: 0,
      refused: 0,
      questions: 1,
      tokens: 10,
      costMicroUsd,
      ms: 1,
      updatedAt: Date.now(),
    });
  });
}

describe("the roster's AI spend is staff-only", () => {
  test("signed out, and signed in as a stranger, are refused", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const stranger = await seedUser(t, "stranger@example.test");
    const theirs = await seedWorkspace(t, stranger, "theirs");
    await spend(t, theirs, "organizer", 420_000);

    await expect(t.query(api.functions.admin.censusReport, {})).rejects.toThrow();
    await expect(
      t.withIdentity({ subject: stranger }).query(api.functions.admin.censusReport, {}),
    ).rejects.toThrow();
  });
});

describe("the roster's AI spend", () => {
  test("sums every owned workspace and feature in the window, and nothing else", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const staffId = await seedUser(t, ADMIN);
    const alice = await seedUser(t, "alice@example.test");
    const bob = await seedUser(t, "bob@example.test");
    await seedUser(t, "idle@example.test");

    // Alice owns two workspaces and is a plain member of Bob's.
    const aliceOne = await seedWorkspace(t, alice, "alice-one");
    const aliceTwo = await seedWorkspace(t, alice, "alice-two");
    const bobs = await seedWorkspace(t, bob, "bobs", [alice]);

    await spend(t, aliceOne, "organizer", 300_000);
    await spend(t, aliceOne, "ownerSuggest", 20_000, 1);
    await spend(t, aliceTwo, "whatChanged", 100_000, 29);
    // Outside a 30-day window: the 31st day back.
    await spend(t, aliceTwo, "organizer", 5_000_000, 30);
    await spend(t, bobs, "organizer", 7_000);

    const report = await t
      .withIdentity({ subject: staffId })
      .query(api.functions.admin.censusReport, { days: 30 });
    const byEmail = new Map(report.roster.map((row) => [row.email, row]));

    expect(byEmail.get("alice@example.test")).toMatchObject({ aiSpendMicroUsd: 420_000, aiSpendPartial: false });
    expect(byEmail.get("bob@example.test")).toMatchObject({ aiSpendMicroUsd: 7_000, aiSpendPartial: false });
    expect(byEmail.get("idle@example.test")).toMatchObject({ aiSpendMicroUsd: 0, aiSpendPartial: false });
    expect(byEmail.get(ADMIN)).toMatchObject({ aiSpendMicroUsd: 0 });

    // A wider window takes in the older day.
    const wide = await t
      .withIdentity({ subject: staffId })
      .query(api.functions.admin.censusReport, { days: 90 });
    const aliceWide = wide.roster.find((row) => row.email === "alice@example.test");
    expect(aliceWide?.aiSpendMicroUsd).toBe(5_420_000);
  });

  test("a read that runs out of budget is a floor, and says so", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "heavy@example.test");
    const first = await seedWorkspace(t, owner, "first");
    const second = await seedWorkspace(t, owner, "second");
    await spend(t, first, "organizer", 1_000);
    await spend(t, first, "whatChanged", 2_000);
    await spend(t, second, "organizer", 4_000);
    const since = utcDay(Date.now() - 10 * DAY);

    // Maps and Sets do not cross `t.run`, so flatten inside it.
    const read = (budget: number) =>
      t.run(async (ctx) => {
        const { spend, partial } = await aiSpendByWorkspace(ctx, [first, second], since, budget);
        return { spend: Object.fromEntries(spend), partial: [...partial] };
      });

    const exact = await read(10);
    expect(exact.partial).toEqual([]);
    expect(exact.spend).toEqual({ [String(first)]: 3_000, [String(second)]: 4_000 });

    const short = await read(2);
    expect(short.partial).toEqual([String(second)]);
    expect(short.spend).toEqual({ [String(first)]: 3_000 });
  });
});
