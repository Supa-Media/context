/**
 * The owner's controls on a move out of managed storage: stopping it, and
 * being told which files over the file limit it left behind.
 *
 * ## Sabotage record
 *
 * Removing the `readyToCutover` guard from the cancel handler made the third
 * test cancel a move that was seconds from switching. Passing the whole page
 * to the reconcile read the big file; dropping the `leftBehind` patch at the
 * switch left the owner untold; counting every pass counted a file twice.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
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
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { managedBucketName } from "../functions/lib/managedStorage";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function moving(
  options: {
    readyToCutover?: boolean;
    phase?: "count" | "copy" | "verify_target";
    skippedKeys?: string[];
    skippedCount?: number;
  } = {},
) {
  const t = setupTest();
  const owner = await createUser(t, "moving-owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "moving");
  const encrypted = (secret: string) => encryptSecret(secret, requireKeyset(), { workspaceId });
  const sourceBindingId = await t.run(async (ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "r2",
      endpoint: "https://managed-account.r2.cloudflarestorage.example",
      region: "auto",
      bucket: managedBucketName(workspaceId),
      accessKeyId: "managed-token-id",
      encryptedSecretAccessKey: await encrypted("managed-secret-not-real"),
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
      managedProvisioning: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("managedStorageMigrations", {
      workspaceId,
      sourceBindingId,
      direction: "to_customer",
      targetProvider: "r2",
      targetEndpoint: FAKE_STORAGE.endpoint,
      targetRegion: "auto",
      targetBucket: "customer-bucket",
      targetAccessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedTargetSecretAccessKey: await encrypted(FAKE_STORAGE.secretAccessKey),
      status: "copying",
      phase: options.phase ?? "copy",
      objectsCopied: 0,
      objectsTotal: 3,
      objectsProcessedInPhase: 0,
      changesInPass: 0,
      readyToCutover: options.readyToCutover ?? false,
      targetClaimed: true,
      ...(options.skippedKeys ? { skippedKeys: options.skippedKeys } : {}),
      ...(options.skippedCount ? { skippedCount: options.skippedCount } : {}),
      startedBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { t, owner, workspaceId, sourceBindingId };
}

describe("stopping a move out of managed storage", () => {
  test("the owner stops it and nothing about the live workspace changes", async () => {
    const { t, owner, workspaceId, sourceBindingId } = await moving();

    await expect(
      asUser(t, owner).mutation(api.functions.managedHandoff.cancelManagedStorageHandoff, {
        workspaceId,
      }),
    ).resolves.toEqual({ cancelled: true });

    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ status: "failed", errorCode: "CANCELLED" });
    const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
    expect(plan).toMatchObject({ managedStorage: true, managedProvisioning: "ready" });
    const binding = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    expect(binding?._id).toBe(sourceBindingId);

    // A page already queued finds a stopped row and does nothing.
    await expect(
      t.action(internal.functions.managedProvisioning.runManagedStorageMigration, { workspaceId }),
    ).resolves.toEqual({ copied: 0, complete: false });

    const view = await asUser(t, owner).query(api.functions.storage.getStorageBinding, {
      workspaceId,
    });
    expect(view).toMatchObject({
      handoffStatus: "failed",
      handoffErrorCode: "CANCELLED",
      handoffBucket: "customer-bucket",
    });
  });

  test("only the owner can stop it", async () => {
    const { t, owner, workspaceId } = await moving();
    const member = await createUser(t, "moving-member@example.invalid");
    await addMember(t, workspaceId, member, "editor", owner);
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, member).mutation(api.functions.managedHandoff.cancelManagedStorageHandoff, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("INSUFFICIENT_ROLE");
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row?.status).toBe("copying");
  });

  test("a move already switching over is not interrupted", async () => {
    const { t, owner, workspaceId } = await moving({ readyToCutover: true });
    await expect(
      asUser(t, owner).mutation(api.functions.managedHandoff.cancelManagedStorageHandoff, {
        workspaceId,
      }),
    ).resolves.toEqual({ cancelled: false });
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row?.status).toBe("copying");
  });
});

describe("a file over the file limit", () => {
  test("stays where it is, named, and the move carries on without reading it", async () => {
    const { t, owner, workspaceId } = await moving();
    const reads: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
      if (url.includes("list-type=2")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
            "<Contents><Key>meetings/kickoff.m4a</Key><Size>20971521</Size></Contents>" +
            "</ListBucketResult>",
          headers: new Headers(),
        };
      }
      reads.push(`${init?.method ?? "GET"} ${url}`);
      return { ok: true, status: 200, text: async () => "", headers: new Headers({ etag: '"abc"' }) };
    });

    await t.action(internal.functions.managedProvisioning.runManagedStorageMigration, {
      workspaceId,
    });

    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({
      status: "copying",
      phase: "verify_source",
      skippedKeys: ["meetings/kickoff.m4a"],
      skippedCount: 1,
    });
    expect(row?.errorCode).toBeUndefined();
    expect(reads.filter((line) => line.includes("kickoff"))).toEqual([]);
    const view = await asUser(t, owner).query(api.functions.storage.getStorageBinding, {
      workspaceId,
    });
    expect(view?.handoffStatus).toBe("copying");
  });

  test("a later pass adds a name it has not seen without counting a file twice", async () => {
    const { t, workspaceId } = await moving({ skippedKeys: ["a.mov"], skippedCount: 1 });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("managedStorageMigrations").unique();
      await ctx.db.patch(row!._id, { phase: "verify_source" });
    });
    await t.mutation(internal.functions.managedProvisioning.recordMigrationPage, {
      workspaceId,
      nextCursor: "next",
      copied: 0,
      changes: 0,
      processed: 2,
      skipped: ["a.mov", "b.mov"],
    });
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ skippedKeys: ["a.mov", "b.mov"], skippedCount: 2 });
  });

  test("a fresh census forgets what an earlier walk left behind", async () => {
    const { t, workspaceId } = await moving({ phase: "count", skippedKeys: ["a.mov"], skippedCount: 1 });
    await t.mutation(internal.functions.managedProvisioning.recordMigrationPage, {
      workspaceId,
      copied: 0,
      changes: 0,
      processed: 3,
    });
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row?.phase).toBe("copy");
    expect(row?.skippedKeys).toBeUndefined();
    expect(row?.skippedCount).toBeUndefined();
  });

  test("after the switch the owner is told what stayed, and only the owner can put it away", async () => {
    const { t, owner, workspaceId } = await moving({
      phase: "verify_target",
      readyToCutover: true,
      skippedKeys: ["meetings/kickoff.m4a"],
      skippedCount: 1,
    });
    const member = await createUser(t, "moving-member@example.invalid");
    await addMember(t, workspaceId, member, "member");

    await expect(
      t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, { workspaceId }),
    ).resolves.toEqual({ cutover: true });

    const ownerView = await asUser(t, owner).query(api.functions.storage.getStorageBinding, { workspaceId });
    expect(ownerView?.leftBehind).toMatchObject({
      bucket: managedBucketName(workspaceId),
      keys: ["meetings/kickoff.m4a"],
      count: 1,
    });
    const memberView = await asUser(t, member).query(api.functions.storage.getStorageBinding, { workspaceId });
    expect(memberView?.leftBehind).toBeUndefined();

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, member).mutation(api.functions.managedHandoff.dismissLeftBehind, { workspaceId }),
        ),
      ),
    ).toBeTruthy();
    await asUser(t, owner).mutation(api.functions.managedHandoff.dismissLeftBehind, { workspaceId });
    const after = await asUser(t, owner).query(api.functions.storage.getStorageBinding, { workspaceId });
    expect(after?.leftBehind).toBeUndefined();
  });

  test("a move that left nothing behind says nothing", async () => {
    const { t, owner, workspaceId } = await moving({ phase: "verify_target", readyToCutover: true });
    await t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, { workspaceId });
    const view = await asUser(t, owner).query(api.functions.storage.getStorageBinding, { workspaceId });
    expect(view?.leftBehind).toBeUndefined();
  });
});
