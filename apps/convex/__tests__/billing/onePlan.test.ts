/**
 * PREMIUM IS ONE PLAN: PRESSING UPGRADE IS THE WHOLE CHOICE.
 *
 * Decided 2026-09-28 (`docs/decisions/billing.md`, "One plan"). The owner no
 * longer ticks managed storage or fast search before paying, so the upgrade
 * fills the selection in, and two things about how it does that matter:
 *
 * - **Paying never starts moving somebody's notes.** A context on the owner's
 *   own storage is never switched to managed storage by an upgrade.
 * - **Turning the index off is not undone by resubscribing.** Fast search is
 *   added only for a context that has never paid.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `selectionAtUpgrade` turning managed storage on for everybody          4
 *   `selectionAtUpgrade` turning fast search on after a lapse              1
 *   `startCheckout` freezing an empty selection on the attempt row         3
 */

import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  type TestConvex,
  asUser,
  createUser,
  createWorkspace,
  seedStorageBinding,
  setupTest,
} from "../fixtures.helpers";
import {
  MANAGED_R2_ACCOUNT_ID_ENV_VAR,
  managedBucketName,
} from "../../functions/lib/managedStorage";
import { selectionAtUpgrade } from "../../functions/lib/premium";
import { TEST_ACCOUNT_EMAIL } from "../../functions/lib/testAccount";
import { context } from "./fixtures.helpers";

/** Fake, and shaped like a Cloudflare account id. This repository is public. */
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

async function plan(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("workspacePlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );
}

async function onOurBucket(t: TestConvex, owner: Id<"users">, workspaceId: Id<"workspaces">) {
  vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, ACCOUNT_ID);
  await seedStorageBinding(t, {
    workspaceId,
    boundBy: owner,
    bucket: managedBucketName(workspaceId),
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
      status: "none",
      freeManaged: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

describe("what pressing Upgrade buys", () => {
  test("a free context on our bucket keeps it and gets fast search", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "free-managed-upgrade");
    await onOurBucket(t, owner, workspaceId);

    const { sessionId } = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );

    expect(await plan(t, workspaceId)).toMatchObject({ managedStorage: true, fastSearch: true });
    const attempt = await t.run((ctx) => ctx.db.get(sessionId));
    expect(attempt?.selectedAtCheckout).toEqual({ managedStorage: true, fastSearch: true });
  });

  test("a context on its owner's own storage is never moved by paying", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "own-bucket-upgrade");
    await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: "their-own-bucket" });

    const { sessionId } = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );

    expect(await plan(t, workspaceId)).toMatchObject({ managedStorage: false, fastSearch: true });
    const attempt = await t.run((ctx) => ctx.db.get(sessionId));
    expect(attempt?.selectedAtCheckout).toEqual({ managedStorage: false, fastSearch: true });
  });

  test("an earlier choice of managed storage is kept, not taken away", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "onboarding-paid-bucket");
    await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
    });
    await asUser(t, owner).mutation(api.functions.billing.startCheckout, { workspaceId });
    expect(await plan(t, workspaceId)).toMatchObject({ managedStorage: true, fastSearch: true });
  });

  test("a context already on Premium is refused and its choice left alone", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "already-premium");
    await onOurBucket(t, owner, workspaceId);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("workspacePlans").collect())[0]!;
      await ctx.db.patch(row._id, { status: "active" });
    });
    await expect(
      asUser(t, owner).mutation(api.functions.billing.startCheckout, { workspaceId }),
    ).rejects.toMatchObject({ data: expect.objectContaining({ code: "ALREADY_PREMIUM" }) });
    expect(await plan(t, workspaceId)).toMatchObject({ managedStorage: true, fastSearch: false });
  });

  test("the test upgrade needs nothing ticked either", async () => {
    const t = setupTest();
    const owner = await createUser(t, TEST_ACCOUNT_EMAIL);
    const workspaceId = await createWorkspace(t, owner, "test-one-plan");
    await expect(
      asUser(t, owner).mutation(api.functions.billing.activateTestPremium, { workspaceId }),
    ).resolves.toEqual({ active: true });
    expect(await plan(t, workspaceId)).toMatchObject({
      status: "active",
      managedStorage: false,
      fastSearch: true,
    });
  });
});

describe("selectionAtUpgrade", () => {
  const none = { managedStorage: false, fastSearch: false };

  test("storage follows where the notes already are", () => {
    expect(selectionAtUpgrade(none, "none", true)).toEqual({ managedStorage: true, fastSearch: true });
    expect(selectionAtUpgrade(none, "none", false)).toEqual({ managedStorage: false, fastSearch: true });
  });

  test("an index turned off before a lapse stays off when resubscribing", () => {
    expect(
      selectionAtUpgrade({ managedStorage: true, fastSearch: false }, "canceled", true),
    ).toEqual({ managedStorage: true, fastSearch: false });
  });

  test("but a resubscription never buys nothing", () => {
    expect(selectionAtUpgrade(none, "canceled", false)).toEqual({
      managedStorage: false,
      fastSearch: true,
    });
  });
});
