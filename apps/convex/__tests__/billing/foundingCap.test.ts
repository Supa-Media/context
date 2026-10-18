/**
 * THE FOUNDERS' DEAL IS LIMITED PREMIUM, NOT PAID PREMIUM.
 *
 * Decided by the owner (Dev2), 2026-10-17: the first 100 accounts get Premium
 * at no charge, but "it shouldn't be the exact same as people paying" — the
 * free tier's 1,000-note cap stays on storage we run. Everything else Premium
 * turns on stays on (`founding.test.ts`). What has to hold: a founder at no
 * charge is capped and may buy full Premium to lift it; a founder paying
 * through Stripe is uncapped and is not sold a second plan; a founder whose
 * subscription ended is capped again; nobody else's cap moves.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `noteCapFor` ignoring `foundingAtNoCharge`                           3
 *   `startCheckout` refusing every active plan, founders included        1
 *   `foundingAtNoCharge` true for a founder with a live subscription     2
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  type TestConvex,
  asUser,
  createUser,
  createWorkspace,
  seedStorageBinding,
  setupTest,
} from "../fixtures.helpers";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { FREE_MANAGED_NOTE_CAP, foundingAtNoCharge, noteCapFor } from "../../functions/lib/premium";

/** A founder's personal workspace on a bucket we run, granted by the walk. */
async function founder(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}@example.invalid`);
  await t.mutation(internal.functions.foundingPremium.catchUp, {});
  const workspaceId = await createWorkspace(t, owner, slug, { kind: "personal" });
  await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: managedBucketName(workspaceId) });
  return { owner, workspaceId: workspaceId as Id<"workspaces"> };
}

async function patchPlan(t: TestConvex, workspaceId: Id<"workspaces">, fields: Record<string, unknown>) {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("workspacePlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    await ctx.db.patch(row!._id, fields);
  });
}

describe("the rule", () => {
  test("a founder at no charge is capped; one paying through Stripe is not", () => {
    const free = { founding: true, status: "active" as const };
    expect(foundingAtNoCharge(free)).toBe(true);
    expect(noteCapFor(free, true)).toBe(FREE_MANAGED_NOTE_CAP);

    const paying = { ...free, stripeCustomerId: "cus_FAKE", stripeStatus: "active" as const };
    expect(foundingAtNoCharge(paying)).toBe(false);
    expect(noteCapFor(paying, true)).toBeNull();

    // A row from before `stripeStatus` existed reads Stripe's word from `status`.
    expect(foundingAtNoCharge({ ...free, stripeCustomerId: "cus_FAKE" })).toBe(false);

    const ended = { ...paying, stripeStatus: "canceled" as const };
    expect(foundingAtNoCharge(ended)).toBe(true);
    expect(noteCapFor(ended, true)).toBe(FREE_MANAGED_NOTE_CAP);

    // Their own bucket is never capped by us, founding or not.
    expect(noteCapFor(free, false)).toBeNull();
    // Paid Premium that is not founding is untouched.
    expect(noteCapFor({ status: "active" }, true)).toBeNull();
  });
});

describe("a founder on storage we run", () => {
  test("is Premium and still sees the 1,000-note cap", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await founder(t, "capped-founder");
    const status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
    expect(status).toMatchObject({ status: "active", founding: true, noteCap: FREE_MANAGED_NOTE_CAP });
    expect(await t.query(internal.functions.billing.noteCap, { workspaceId })).toBe(FREE_MANAGED_NOTE_CAP);
  });

  test("may buy full Premium to lift the cap", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await founder(t, "buying-founder");
    const { sessionId } = await asUser(t, owner).mutation(api.functions.billing.startCheckout, {
      workspaceId,
    });
    expect(sessionId).toBeDefined();
  });

  test("once paying, is uncapped and is not sold a second plan; once cancelled, is capped again", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await founder(t, "paying-founder");
    await patchPlan(t, workspaceId, {
      stripeCustomerId: "cus_FAKE",
      stripeSubscriptionId: "sub_FAKE",
      stripeStatus: "active",
    });
    expect(await t.query(internal.functions.billing.noteCap, { workspaceId })).toBeNull();
    await expect(
      asUser(t, owner).mutation(api.functions.billing.startCheckout, { workspaceId }),
    ).rejects.toMatchObject({ data: expect.objectContaining({ code: "ALREADY_PREMIUM" }) });

    await t.mutation(internal.functions.billing.applyStripeEvent, {
      id: "evt_fake_founder_deleted",
      type: "customer.subscription.deleted",
      createdSeconds: 1_780_000_300,
      subscriptionId: "sub_FAKE",
      rawStatus: "canceled",
    });
    expect(await t.query(internal.functions.billing.noteCap, { workspaceId })).toBe(FREE_MANAGED_NOTE_CAP);
  });
});
