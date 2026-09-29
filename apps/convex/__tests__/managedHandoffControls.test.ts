/**
 * The owner's controls on a move out of managed storage: stopping it, and
 * being told which files stopped it.
 *
 * ## Sabotage record
 *
 * Removing the `readyToCutover` guard from the cancel handler made the third
 * test cancel a move that was seconds from switching. Dropping `failedKeys`
 * from the run loop's failure call left the last test's row without the file.
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

async function moving(options: { readyToCutover?: boolean; phase?: "count" | "copy" } = {}) {
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

describe("a move stopped by particular files", () => {
  test("names the files that were too large to move", async () => {
    const { t, owner, workspaceId } = await moving();
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("list-type=2")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
            "<Contents><Key>1-projects/plan.md</Key><Size>40</Size></Contents>" +
            "<Contents><Key>meetings/kickoff.m4a</Key><Size>99999999</Size></Contents>" +
            "</ListBucketResult>",
          headers: new Headers(),
        };
      }
      return { ok: true, status: 200, text: async () => "", headers: new Headers({ etag: '"abc"' }) };
    });

    await t.action(internal.functions.managedProvisioning.runManagedStorageMigration, {
      workspaceId,
    });

    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({
      status: "failed",
      errorCode: "OBJECT_TOO_LARGE",
      failedKeys: ["meetings/kickoff.m4a"],
    });
    const view = await asUser(t, owner).query(api.functions.storage.getStorageBinding, {
      workspaceId,
    });
    expect(view?.handoffFailedKeys).toEqual(["meetings/kickoff.m4a"]);
  });
});
