import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { asUser, createUser, createWorkspace, setupTest } from "../fixtures.helpers";
import { MANAGED_R2_ACCOUNT_ID_ENV_VAR } from "../../functions/lib/managedStorage";
import { context } from "./fixtures.helpers";

/**
 * An isolated per-branch preview gets the staging billing conveniences and
 * nothing more: a test upgrade with no Stripe, a zero price, and the
 * "free storage" answer. Production refuses the test upgrade for anyone who
 * is not the one production test account.
 */

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

const PREVIEW = {
  APP_ENV: "preview",
  PREVIEW_NAME: "pr42",
  APP_ORIGIN: "https://context-router-pr42.example-sub.workers.dev",
  CONVEX_CLOUD_URL: "https://happy-otter-123.convex.cloud",
  [MANAGED_R2_ACCOUNT_ID_ENV_VAR]: ACCOUNT_ID,
};

const PRODUCTION = {
  APP_ENV: "production",
  APP_ORIGIN: "https://context.lc",
  CONVEX_CLOUD_URL: "https://prod-example-1.convex.cloud",
  [MANAGED_R2_ACCOUNT_ID_ENV_VAR]: ACCOUNT_ID,
};

function deploy(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

afterEach(() => vi.unstubAllEnvs());

describe("an isolated preview's billing", () => {
  test("activates the test upgrade without Stripe, for an ordinary owner", async () => {
    deploy(PREVIEW);
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "preview-premium");
    await expect(
      asUser(t, owner).mutation(api.functions.billing.activateTestPremium, { workspaceId }),
    ).resolves.toEqual({ active: true });
    const status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
    expect(status).toMatchObject({ status: "active", stagingFreeStorage: true, priceCents: 0, configured: true });
    expect(status.hasStripeCustomer).toBe(false);
  });

  test("records the preview's own audit action", async () => {
    deploy(PREVIEW);
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "preview-audit");
    await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
      workspaceId, managedStorage: false, fastSearch: true,
    });
    await asUser(t, owner).mutation(api.functions.billing.activateTestPremium, { workspaceId });
    const audits = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audits.map((row) => row.action)).toContain("billing.preview_plan_activated");
    expect(audits.map((row) => row.action)).not.toContain("billing.test_plan_activated");
  });

  test("refuses checkout with the staging no-payment code, as staging does", async () => {
    deploy(PREVIEW);
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "preview-checkout");
    await expect(asUser(t, owner).mutation(api.functions.billing.startCheckout, { workspaceId }))
      .rejects.toMatchObject({ data: expect.objectContaining({ code: "STAGING_NO_PAYMENT" }) });
  });
});

describe("production's billing does not widen", () => {
  test("an ordinary owner is refused the test upgrade", async () => {
    deploy(PRODUCTION);
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "prod-ordinary");
    await expect(
      asUser(t, owner).mutation(api.functions.billing.activateTestPremium, { workspaceId }),
    ).rejects.toMatchObject({ data: expect.objectContaining({ code: "FORBIDDEN" }) });
  });

  test("the preview variables copied onto production still refuse an ordinary owner", async () => {
    deploy({ ...PRODUCTION, APP_ENV: "preview", PREVIEW_NAME: "pr42" });
    const t = setupTest();
    const owner = await createUser(t, "copied-owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "copied-premium");
    await expect(
      asUser(t, owner).mutation(api.functions.billing.activateTestPremium, { workspaceId }),
    ).rejects.toMatchObject({ data: expect.objectContaining({ code: "FORBIDDEN" }) });
  });
});
