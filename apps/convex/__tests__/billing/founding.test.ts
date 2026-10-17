/**
 * FOUNDING PREMIUM: THE FIRST 100 ACCOUNTS ARE PREMIUM, AND NOBODY PAYS.
 *
 * Decided by the owner (Dev2), 2026-10-17 (`docs/decisions/billing.md`,
 * "Founding Premium"). What has to hold: the cap is exact (the 100th account
 * has it, the 101st does not), it is stable (a founder leaving frees no slot),
 * it follows account creation order, the personal workspace's plan is what
 * every Premium gate reads, including Tex's dream through the built-in model,
 * and nothing about it opens a checkout or can be undone by a Stripe event.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   the walk's cap check `>=` loosened to `>`                            2
 *   `createWorkspaceHandler` not applying an existing grant              3
 *   the walk not applying a grant to an existing personal workspace      2
 *   `foundingStatus` returning Stripe's status unchanged                 2
 *   `excludedFromFounding` ignoring the staff allowlist                  2
 *   `billing.status` reporting `founding: false` for every plan          1
  `applyStripeEvent` not recording Stripe's own status                 1
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  type TestConvex,
  asUser,
  createUser,
  createWorkspace,
  gatewayPost,
  setupTest,
} from "../fixtures.helpers";
import {
  FOUNDING_PREMIUM_ACCOUNTS,
  excludedFromFounding,
  foundingStatus,
} from "../../functions/lib/billing/founding";
import { TEST_ACCOUNT_EMAIL } from "../../functions/lib/testAccount";
import { REVIEWER_EMAIL } from "../../functions/lib/reviewerAccount";

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllEnvs();
});

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";

/** `count` accounts, oldest first, with no workspace. */
async function accounts(t: TestConvex, count: number, prefix = "early"): Promise<Id<"users">[]> {
  return await t.run(async (ctx) => {
    const ids: Id<"users">[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(
        await ctx.db.insert("users", {
          email: `${prefix}-${i}@example.invalid`,
          emailVerificationTime: Date.now(),
          createdAt: Date.now(),
        }),
      );
    }
    return ids;
  });
}

async function catchUp(t: TestConvex): Promise<number> {
  return (await t.mutation(internal.functions.foundingPremium.catchUp, {})).granted;
}

async function plan(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("workspacePlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );
}

async function grants(t: TestConvex) {
  return await t.run((ctx) => ctx.db.query("foundingPremium").collect());
}

describe("who is founding", () => {
  test("the 100th account is Premium and the 101st is not", async () => {
    expect(FOUNDING_PREMIUM_ACCOUNTS).toBe(100);
    const t = setupTest();
    const early = await accounts(t, FOUNDING_PREMIUM_ACCOUNTS - 1);
    const hundredth = await createUser(t, "hundredth@example.invalid");
    const hundredFirst = await createUser(t, "hundred-first@example.invalid");
    expect(await catchUp(t)).toBe(FOUNDING_PREMIUM_ACCOUNTS);

    // The grant reaches a personal workspace made afterwards.
    const theirs = await createWorkspace(t, hundredth, "hundredth", { kind: "personal" });
    const notTheirs = await createWorkspace(t, hundredFirst, "hundred-first", { kind: "personal" });
    expect(await plan(t, theirs)).toMatchObject({ status: "active", founding: true });
    expect(await plan(t, notTheirs)).toBeNull();

    const all = await grants(t);
    expect(all).toHaveLength(FOUNDING_PREMIUM_ACCOUNTS);
    expect(all.find((g) => g.userId === hundredth)?.seq).toBe(FOUNDING_PREMIUM_ACCOUNTS);
    expect(all.find((g) => g.userId === early[0])?.seq).toBe(1);
    expect(all.some((g) => g.userId === hundredFirst)).toBe(false);
  });

  test("an account that already had a personal workspace is upgraded in place", async () => {
    const t = setupTest();
    const owner = await createUser(t, "already-here@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "already-here", { kind: "personal" });
    const shared = await createWorkspace(t, owner, "their-team", { kind: "shared" });
    expect(await catchUp(t)).toBe(1);
    expect(await plan(t, workspaceId)).toMatchObject({ status: "active", founding: true });
    // A plan belongs to a workspace: a shared one pays as it would.
    expect(await plan(t, shared)).toBeNull();
    // Idempotent.
    expect(await catchUp(t)).toBe(0);
  });

  test("a founder leaving frees no slot", async () => {
    const t = setupTest();
    const early = await accounts(t, FOUNDING_PREMIUM_ACCOUNTS);
    expect(await catchUp(t)).toBe(FOUNDING_PREMIUM_ACCOUNTS);
    await t.run((ctx) => ctx.db.delete(early[0]!));
    const late = await createUser(t, "late@example.invalid");
    expect(await catchUp(t)).toBe(0);
    expect((await grants(t)).some((g) => g.userId === late)).toBe(false);
  });

  test("older accounts come first, and staff and test identities take no slot", async () => {
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
    const t = setupTest();
    const staff = await createUser(t, "staff@example.invalid");
    const cuj = await createUser(t, TEST_ACCOUNT_EMAIL);
    const first = await createUser(t, "first@example.invalid");
    const second = await createUser(t, "second@example.invalid");
    expect(await catchUp(t)).toBe(2);
    const all = await grants(t);
    expect(all.map((g) => [g.userId, g.seq])).toEqual([
      [first, 1],
      [second, 2],
    ]);
    expect(all.some((g) => g.userId === staff || g.userId === cuj)).toBe(false);
  });

  test("the exclusions are read from the address", () => {
    const env = { ADMIN_EMAILS: "staff@example.invalid" };
    expect(excludedFromFounding({ email: " Staff@Example.invalid " }, env)).toBe(true);
    expect(excludedFromFounding({ email: TEST_ACCOUNT_EMAIL }, env)).toBe(true);
    expect(excludedFromFounding({ email: REVIEWER_EMAIL }, env)).toBe(true);
    expect(excludedFromFounding({ email: "alpha@supa.media" }, env)).toBe(true);
    expect(excludedFromFounding({ email: "person@example.invalid" }, env)).toBe(false);
    expect(excludedFromFounding({ phone: "+15555550111" }, env)).toBe(false);
  });
});

describe("nobody is charged, and Stripe cannot take it away", () => {
  test("a founding workspace is active with nobody billed", async () => {
    // A founder may still choose to buy full Premium, which lifts the note
    // cap (`foundingCap.test.ts`); being granted founding opens nothing.
    const t = setupTest();
    const owner = await createUser(t, "first-person@example.invalid");
    await catchUp(t);
    const workspaceId = await createWorkspace(t, owner, "first-person", { kind: "personal" });
    expect(await plan(t, workspaceId)).toMatchObject({ status: "active", founding: true });
    expect(await t.run((ctx) => ctx.db.query("billingSessions").collect())).toEqual([]);
    expect((await plan(t, workspaceId))?.stripeCustomerId).toBeUndefined();
  });

  test("the status says the plan is founding, so the console can say why nothing is charged", async () => {
    const t = setupTest();
    const owner = await createUser(t, "first-reader@example.invalid");
    await catchUp(t);
    const workspaceId = await createWorkspace(t, owner, "first-reader", { kind: "personal" });
    const status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
    expect(status).toMatchObject({ status: "active", founding: true, hasStripeCustomer: false });

    const late = await createUser(t, "not-founding@example.invalid");
    const other = await createWorkspace(t, late, "not-founding", { kind: "shared" });
    expect(
      (await asUser(t, late).query(api.functions.billing.status, { workspaceId: other })).founding,
    ).toBe(false);
  });

  test("a founder who was already paying is marked, and their cancellation keeps Premium", async () => {
    const t = setupTest();
    const owner = await createUser(t, "subscriber@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "subscriber", { kind: "personal" });
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("workspacePlans", {
        workspaceId,
        managedStorage: false,
        fastSearch: true,
        status: "active",
        stripeCustomerId: "cus_FAKE",
        stripeSubscriptionId: "sub_FAKE",
        createdAt: now,
        updatedAt: now,
      }),
    );
    await catchUp(t);
    expect(await plan(t, workspaceId)).toMatchObject({ status: "active", founding: true });
    const before = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
    expect(before).toMatchObject({ hasStripeCustomer: true, subscriptionLive: true });
    await t.mutation(internal.functions.billing.applyStripeEvent, {
      id: "evt_fake_deleted",
      type: "customer.subscription.deleted",
      createdSeconds: 1_780_000_200,
      subscriptionId: "sub_FAKE",
      rawStatus: "canceled",
    });
    expect(await plan(t, workspaceId)).toMatchObject({ status: "active", stripeStatus: "canceled" });
    // Nothing left to manage: the console draws the founding line, not the portal.
    const after = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
    expect(after).toMatchObject({ status: "active", founding: true, hasStripeCustomer: true, subscriptionLive: false });
  });

  test("a Stripe status never lowers a founding plan, and only a founding one", () => {
    expect(foundingStatus({ founding: true }, "canceled")).toBe("active");
    expect(foundingStatus({ founding: true }, "past_due")).toBe("active");
    expect(foundingStatus({}, "canceled")).toBe("canceled");
  });
});

describe("Tex's dream sees a founding account as Premium", () => {
  async function agentPost(t: TestConvex, path: string, body: unknown) {
    const response = await t.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
      body: JSON.stringify(body),
    });
    return JSON.parse(await response.text()) as Record<string, unknown>;
  }

  /** Link a phone, text once, make the dream due, and ask the built-in model for it. */
  async function dreamVerdict(t: TestConvex, userId: Id<"users">, slug: string) {
    await createWorkspace(t, userId, slug, { kind: "personal" });
    const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone: PHONE });
    await agentPost(t, "/agent-texts/link", { phone: PHONE, code });
    await agentPost(t, "/agent-texts/session", { phone: PHONE });
    await t.run(async (ctx) => {
      const dream = await ctx.db
        .query("texDreams")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();
      await ctx.db.patch(dream!._id, { nextDreamAt: Date.now() - 1000 });
    });
    const due = (await agentPost(t, "/agent-texts/dreams/due", {})).dreams as { accessToken: string }[];
    expect(due).toHaveLength(1);
    const response = await gatewayPost(t, "/gateway/builtin-model", {
      accessToken: due[0]!.accessToken,
      expectedWorkspaceId: null,
    });
    return (JSON.parse(await response.text()) as { verdict: unknown }).verdict;
  }

  test("a founding account's dream may use the built-in model", async () => {
    const t = setupTest();
    const founder = await createUser(t, "dreamer@example.invalid");
    await catchUp(t);
    expect(await dreamVerdict(t, founder, "dreamer")).toMatchObject({ allowed: true });
  });

  test("the 101st account's dream may use it too: Tex is free, only the cap differs", async () => {
    const t = setupTest();
    await accounts(t, FOUNDING_PREMIUM_ACCOUNTS);
    const late = await createUser(t, "late-dreamer@example.invalid");
    await catchUp(t);
    expect(await dreamVerdict(t, late, "late-dreamer")).toMatchObject({ allowed: true });
  });
});
