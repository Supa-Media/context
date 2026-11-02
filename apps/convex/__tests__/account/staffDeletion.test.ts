/**
 * Staff removal of an archived test account by handle (`functions/staffDeletion.ts`;
 * the owner, 2026-11-02: "can you spawn a thread to delete that
 * workspace/account? it's been causing issues").
 *
 * Sabotage: drop the `not_archived` check and "a live account is refused"
 * fails; drop the live-member check and "a real person in an owned workspace
 * blocks it" fails; skip the deletion and "deletes the account" fails.
 */

import { afterEach, describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { addMember, createUser, createWorkspace, seedStorageBinding, setupTest, type TestConvex } from "../fixtures.helpers";
import { TEST_ACCOUNT_EMAIL } from "../../functions/lib/testAccount";

const deployments: TestConvex[] = [];

afterEach(async () => {
  for (const t of deployments.splice(0)) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  }
});

function deployment() {
  const t = setupTest();
  deployments.push(t);
  return t;
}

async function archive(t: TestConvex, userId: Id<"users">) {
  const by = await createUser(t, `archiver-${userId}@example.invalid`);
  await t.run(async (ctx) => {
    await ctx.db.insert("archivedAccounts", { userId, archivedBy: by, archivedAt: Date.now() });
  });
}

const run = (t: TestConvex, handle: string, dryRun: boolean) =>
  t.mutation(internal.functions.staffDeletion.deleteArchivedAccount, { handle, dryRun });

describe("staff deletion of an archived test account", () => {
  test("a dry run reports and changes nothing", async () => {
    const t = deployment();
    const owner = await createUser(t, "old-test@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "old-test");
    await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: "someone-elses-bucket" });
    await archive(t, owner);

    const report = await run(t, "@old-test", true);
    expect(report).toMatchObject({ found: true, blockers: [], ownedWorkspaces: 1, customerBuckets: 1, managedBuckets: 0, deleted: false });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(owner)).not.toBeNull();
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
    });
  });

  test("deletes the account and its workspace, and the handle is free after", async () => {
    const t = deployment();
    const owner = await createUser(t, "old-test@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "old-test");
    await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: "someone-elses-bucket" });
    await archive(t, owner);

    const report = await run(t, "old-test", false);
    expect(report).toMatchObject({ found: true, blockers: [], deleted: true });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(owner)).toBeNull();
      expect(await ctx.db.get(workspaceId)).toBeNull();
      expect(await ctx.db.query("archivedAccounts").collect()).toEqual([]);
    });
    expect(await run(t, "old-test", true)).toMatchObject({ found: false, blockers: ["not_found"], archivedAccounts: 0 });
  });

  test("a live account is refused", async () => {
    const t = deployment();
    const owner = await createUser(t, "live@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "live-one");

    const report = await run(t, "live-one", false);
    expect(report.blockers).toEqual(["not_archived"]);
    expect(report.deleted).toBe(false);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
    });
  });

  test("a real person in an owned workspace blocks it", async () => {
    const t = deployment();
    const owner = await createUser(t, "old-test@example.invalid");
    await createWorkspace(t, owner, "old-test");
    const team = await createWorkspace(t, owner, "old-team", { kind: "shared" });
    const friend = await createUser(t, "friend@example.invalid");
    await addMember(t, team, friend, "member", owner);
    await archive(t, owner);

    const report = await run(t, "old-test", false);
    expect(report).toMatchObject({ blockers: ["live_people_in_owned_workspace"], ownedShared: 1, liveOthersInOwned: 1, deleted: false });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(owner)).not.toBeNull();
      expect(await ctx.db.get(team)).not.toBeNull();
    });
  });

  test("the production CUJ account is refused even when archived", async () => {
    const t = deployment();
    const owner = await createUser(t, TEST_ACCOUNT_EMAIL);
    await createWorkspace(t, owner, "cuj-one");
    await archive(t, owner);

    const report = await run(t, "cuj-one", false);
    expect(report.blockers).toContain("production_test_account");
    expect(report.deleted).toBe(false);
  });

  test("a shared workspace's handle is not an account", async () => {
    const t = deployment();
    const owner = await createUser(t, "old-test@example.invalid");
    await createWorkspace(t, owner, "old-test");
    await createWorkspace(t, owner, "old-team", { kind: "shared" });
    await archive(t, owner);

    expect((await run(t, "old-team", false)).blockers).toContain("not_personal");
  });
});
