/**
 * A WORKSPACE ALREADY ON PREMIUM CAN MOVE ONTO STORAGE WE RUN, AND THE MOVE
 * STARTS WHEN THE OWNER ASKS.
 *
 * Choosing "storage we run" in Settings › Storage on a paying workspace that
 * lives in the owner's own bucket turns managed storage on. The copy from their
 * bucket used to be started only by the Stripe webhook, so a workspace that was
 * already paying waited for the next billing event (usually the renewal) while
 * the Premium page said the bucket was being created.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `setEntitlements` not starting the move at all                          2
 *   starting it for a workspace that is not paying                          2
 *     (measured by calling it outside the paying branch as if active)
 *   starting it again while one is already running                          1
 */

import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { type TestConvex, asUser, seedStorageBinding, setupTest } from "../fixtures.helpers";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { context } from "./fixtures.helpers";

async function seedPlan(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  over: { status: "none" | "active"; managedStorage?: boolean; managedProvisioning?: "running" },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: over.managedStorage ?? false,
      fastSearch: true,
      status: over.status,
      managedProvisioning: over.managedProvisioning,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function moves(t: TestConvex) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.filter((job) => String(job.name).includes("provisionManagedStorage"));
}

async function chooseManaged(t: TestConvex, owner: Id<"users">, workspaceId: Id<"workspaces">) {
  await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
    workspaceId,
    managedStorage: true,
    fastSearch: true,
  });
}

describe("moving a paying workspace onto storage we run", () => {
  test("choosing it starts the copy from the owner's bucket straight away", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "move-now");
    await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: "their-own-bucket" });
    await seedPlan(t, workspaceId, { status: "active" });

    await chooseManaged(t, owner, workspaceId);

    expect(await moves(t)).toHaveLength(1);
    const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
    expect(plan?.managedProvisioning).toBe("running");
  });

  test("a workspace that is not paying only records the choice", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "move-unpaid");
    await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: "their-own-bucket" });
    await seedPlan(t, workspaceId, { status: "none" });

    await chooseManaged(t, owner, workspaceId);
    expect(await moves(t)).toHaveLength(0);
  });

  test("nothing starts when the notes are already on our storage", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "move-already");
    await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: managedBucketName(workspaceId) });
    await seedPlan(t, workspaceId, { status: "active" });

    await chooseManaged(t, owner, workspaceId);
    expect(await moves(t)).toHaveLength(0);
  });

  test("a move already under way is not started twice", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "move-twice");
    await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: "their-own-bucket" });
    await seedPlan(t, workspaceId, { status: "active", managedStorage: true, managedProvisioning: "running" });

    await chooseManaged(t, owner, workspaceId);
    expect(await moves(t)).toHaveLength(0);
  });
});
