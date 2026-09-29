/**
 * Leaving managed storage with the whole bucket intact.
 *
 * This is the launch gate for the free tier: an owner can paste a bucket they
 * control, Context copies and verifies every raw object while the managed
 * bucket stays live, and only then swaps the binding. The path is plan-blind —
 * free, paid and cancelled owners get the same exit.
 *
 * ## Sabotage record
 *
 * Temporarily reversing both source-identity comparisons in the cutover
 * mutation made the changed-source case cut over and schedule deletion. The
 * final test failed on `{ cutover: true }`, proving it guards the destructive
 * boundary rather than merely documenting it.
 *
 * Skipping the retired-token revocation left a switched-back workspace's old
 * token standing, and ignoring a later `managedRetainedUntil` let the first
 * move's job delete the bucket inside the second move's week; one test each
 * failed.
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";
import { decryptSecret, encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { managedBucketName } from "../functions/lib/managedStorage";
import { configured } from "./managedProvisioning/fixtures.helpers";

async function managedContext() {
  const t = setupTest();
  const owner = await createUser(t, "handoff-owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "handoff");
  const encryptedSecretAccessKey = await encryptSecret(
    "managed-secret-not-real",
    requireKeyset(),
    { workspaceId },
  );
  const sourceBindingId = await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "r2",
      endpoint: "https://managed-account.r2.cloudflarestorage.example",
      region: "auto",
      bucket: managedBucketName(workspaceId),
      accessKeyId: "managed-token-id",
      encryptedSecretAccessKey,
      status: "connected",
      capabilities: { conditionalWrite: true },
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
      freeManaged: true,
      status: "none",
      managedProvisioning: "ready",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { t, owner, workspaceId, sourceBindingId };
}

describe("managed-storage handoff", () => {
  test("parks an encrypted customer destination without replacing the live source", async () => {
    const { t, owner, workspaceId, sourceBindingId } = await managedContext();

    await expect(
      asUser(t, owner).action(api.functions.storage.startManagedStorageHandoff, {
        workspaceId,
        ...FAKE_STORAGE,
        bucket: "customer-owned-context",
        rootPrefix: "notes",
      }),
    ).resolves.toEqual({ started: true });

    const current = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    expect(current?._id).toBe(sourceBindingId);
    expect(current?.bucket).toBe(managedBucketName(workspaceId));

    const migration = await t.run((ctx) =>
      ctx.db.query("managedStorageMigrations").unique(),
    );
    expect(migration).toMatchObject({
      workspaceId,
      sourceBindingId,
      direction: "to_customer",
      targetProvider: "r2",
      targetBucket: "customer-owned-context",
      targetRootPrefix: "notes/",
      status: "copying",
      phase: "count",
    });
    expect(JSON.stringify(migration)).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(
      await decryptSecret(
        migration!.encryptedTargetSecretAccessKey,
        requireKeyset(),
        { workspaceId },
      ),
    ).toBe(FAKE_STORAGE.secretAccessKey);

    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs.some((job) => job.name.includes("awaitManagedTargetReady"))).toBe(true);
  });

  test("is owner-only and is not gated by a paid or active plan", async () => {
    const { t, owner, workspaceId } = await managedContext();
    const member = await createUser(t, "handoff-member@example.invalid");
    await addMember(t, workspaceId, member, "member", owner);

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, member).action(api.functions.storage.startManagedStorageHandoff, {
            workspaceId,
            ...FAKE_STORAGE,
          }),
        ),
      ),
    ).toBe("INSUFFICIENT_ROLE");

    await t.run(async (ctx) => {
      const plan = await ctx.db.query("workspacePlans").unique();
      await ctx.db.patch(plan!._id, { status: "canceled" });
    });
    await expect(
      asUser(t, owner).action(api.functions.storage.startManagedStorageHandoff, {
        workspaceId,
        ...FAKE_STORAGE,
      }),
    ).resolves.toEqual({ started: true });

    const ownerView = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(ownerView?.handoffStatus).toBe("copying");
    const memberView = await asUser(t, member).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(memberView?.handoffStatus).toBeUndefined();
    expect(memberView?.handoffErrorCode).toBeUndefined();
  });

  test("a bucket-name collision without a managed plan cannot enter the destructive path", async () => {
    const { t, owner, workspaceId } = await managedContext();
    await t.run(async (ctx) => {
      const plan = await ctx.db.query("workspacePlans").unique();
      await ctx.db.patch(plan!._id, {
        managedStorage: false,
        freeManaged: false,
      });
    });

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, owner).action(api.functions.storage.startManagedStorageHandoff, {
            workspaceId,
            ...FAKE_STORAGE,
          }),
        ),
      ),
    ).toBe("NOT_MANAGED_STORAGE");
    expect(
      await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique()),
    ).toBeNull();
  });

  test("cuts over only after verification and retires the managed source", async () => {
    const { t, owner, workspaceId, sourceBindingId } = await managedContext();
    const encryptedTargetSecretAccessKey = await encryptSecret(
      FAKE_STORAGE.secretAccessKey,
      requireKeyset(),
      { workspaceId },
    );
    await t.run((ctx) =>
      ctx.db.insert("managedStorageMigrations", {
        workspaceId,
        sourceBindingId,
        direction: "to_customer",
        targetProvider: "r2",
        targetEndpoint: FAKE_STORAGE.endpoint,
        targetRegion: FAKE_STORAGE.region,
        targetBucket: FAKE_STORAGE.bucket,
        targetRootPrefix: "archive/",
        targetAccessKeyId: FAKE_STORAGE.accessKeyId,
        encryptedTargetSecretAccessKey,
        status: "copying",
        phase: "verify_target",
        objectsCopied: 14,
        objectsProcessedInPhase: 14,
        changesInPass: 0,
        readyToCutover: true,
        startedBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await expect(
      t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, {
        workspaceId,
      }),
    ).resolves.toEqual({ cutover: true });

    const current = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    expect(current).toMatchObject({
      provider: "r2",
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      rootPrefix: "archive/",
      accessKeyId: FAKE_STORAGE.accessKeyId,
    });
    expect(await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique())).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("workspacePlans").unique())).toMatchObject({
      managedStorage: false,
      freeManaged: false,
    });

    const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.map((event) => event.action)).toContain("storage.managed_handed_off");
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const deletion = jobs.find((job) => job.name.includes("deleteManagedStorageAfterHandoff"));
    // Kept a week so the owner can switch back, not deleted on the spot.
    expect(deletion?.scheduledTime).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
    expect(plan?.managedRetainedUntil).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const ownerView = await asUser(t, owner).query(api.functions.storage.getStorageBinding, {
      workspaceId,
    });
    expect(ownerView?.managedRetainedUntil).toBe(plan?.managedRetainedUntil);
    const finishedMail = jobs.find((job) => job.name.includes("sendHandoffEmail"));
    expect(finishedMail?.args[0]).toMatchObject({ kind: "finished", recipientUserId: owner });
  });

  test("a workspace that switched back inside the week keeps its managed bucket", async () => {
    const { t, workspaceId } = await managedContext();
    await t.run(async (ctx) => {
      const plan = await ctx.db.query("workspacePlans").unique();
      await ctx.db.patch(plan!._id, { managedRetainedUntil: Date.now() });
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => "{}", json: async () => ({}), headers: new Headers() };
    });
    try {
      // The managed binding from `managedContext` is still bound: it is live.
      await expect(
        t.action(internal.functions.managedProvisioning.deleteManagedStorageAfterHandoff, {
          workspaceId,
          bucket: managedBucketName(workspaceId),
          tokenId: "managed-token-id",
        }),
      ).resolves.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toEqual([]);
    const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
    expect(plan?.managedRetainedUntil).toBeUndefined();
  });

  test("a workspace still on its own bucket after the week reaches the deletion", async () => {
    const { t, workspaceId, sourceBindingId } = await managedContext();
    await t.run(async (ctx) => {
      await ctx.db.patch(sourceBindingId, { bucket: "customer-owned-context" });
      const plan = await ctx.db.query("workspacePlans").unique();
      await ctx.db.patch(plan!._id, { managedStorage: false, managedRetainedUntil: Date.now() });
    });
    // No operator account in tests, so reaching the delete is reaching this.
    await expect(
      t.action(internal.functions.managedProvisioning.deleteManagedStorageAfterHandoff, {
        workspaceId,
        bucket: managedBucketName(workspaceId),
        tokenId: "managed-token-id",
      }),
    ).rejects.toThrow(/not configured/);
  });

  test("a switch back revokes the token from before the move, and keeps the bucket", async () => {
    const { t, workspaceId } = await managedContext();
    await configured(t);
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return {
        ok: true,
        status: 200,
        text: async () => '{"success":true,"result":{}}',
        json: async () => ({ success: true, result: {} }),
        headers: new Headers(),
      };
    });
    try {
      // The bound managed bucket holds a newer token; this job's is retired.
      await t.action(internal.functions.managedProvisioning.deleteManagedStorageAfterHandoff, {
        workspaceId,
        bucket: managedBucketName(workspaceId),
        tokenId: "token-from-before-the-move",
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual([
      expect.stringContaining("token-from-before-the-move"),
    ]);
  });

  test("a workspace that came back and left again keeps its bucket for the later week", async () => {
    const { t, workspaceId, sourceBindingId } = await managedContext();
    const first = Date.now();
    const later = first + 3 * 24 * 60 * 60 * 1000;
    await t.run(async (ctx) => {
      await ctx.db.patch(sourceBindingId, { bucket: "customer-owned-context" });
      const plan = await ctx.db.query("workspacePlans").unique();
      await ctx.db.patch(plan!._id, { managedStorage: false, managedRetainedUntil: later });
    });
    // The first move's job, arriving while the second move's week runs.
    await expect(
      t.action(internal.functions.managedProvisioning.deleteManagedStorageAfterHandoff, {
        workspaceId,
        bucket: managedBucketName(workspaceId),
        tokenId: "managed-token-id",
        retainedUntil: first,
      }),
    ).resolves.toBeNull();
    const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
    expect(plan?.managedRetainedUntil).toBe(later);
  });

  test("a changed source fails closed and schedules no managed-bucket deletion", async () => {
    const { t, owner, workspaceId, sourceBindingId } = await managedContext();
    const encryptedTargetSecretAccessKey = await encryptSecret(
      FAKE_STORAGE.secretAccessKey,
      requireKeyset(),
      { workspaceId },
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("managedStorageMigrations", {
        workspaceId,
        sourceBindingId,
        direction: "to_customer",
        targetProvider: "r2",
        targetEndpoint: FAKE_STORAGE.endpoint,
        targetRegion: FAKE_STORAGE.region,
        targetBucket: FAKE_STORAGE.bucket,
        targetAccessKeyId: FAKE_STORAGE.accessKeyId,
        encryptedTargetSecretAccessKey,
        status: "copying",
        phase: "verify_target",
        objectsCopied: 1,
        changesInPass: 0,
        readyToCutover: true,
        startedBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const source = await ctx.db.get(sourceBindingId);
      await ctx.db.delete(source!._id);
      await ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "r2",
        endpoint: "https://other.r2.cloudflarestorage.example",
        region: "auto",
        bucket: "changed-under-copy",
        accessKeyId: "other-key",
        encryptedSecretAccessKey: source!.encryptedSecretAccessKey,
        status: "connected",
        capabilities: { conditionalWrite: true },
        boundBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await expect(
      t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, {
        workspaceId,
      }),
    ).resolves.toEqual({ cutover: false });
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs.some((job) => job.name.includes("deleteManagedStorageAfterHandoff"))).toBe(false);
  });
});
