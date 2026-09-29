/**
 * A move never deletes a customer's file it did not put there, even mid-move.
 *
 * Context sees the whole bucket (owner, 2026-09-29), and the only deletion of
 * the customer's own files is the one they typed the bucket's name to agree
 * to. So "start fresh" empties the bucket once, up front, before anything is
 * copied, and from then on the move's final check may remove only Context's
 * own plumbing under `.context/`. A file the owner adds to their bucket while
 * the move runs is theirs and stays, exactly as "merge on top" keeps theirs.
 *
 * ## Sabotage record
 *
 * Letting the verify pass delete any unmatched key again removed the file
 * added by hand, failing "a file added by hand while the move runs is kept".
 * Claiming whatever the clear reported claimed a bucket that still held a
 * file that would not delete, failing "a bucket that still holds files after
 * a run is not claimed yet". Reporting "empty" from `clearDestination` after
 * its page budget failed the page-budget test, and dropping the stuck check
 * failed "a file that will not go says so rather than trying forever".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { fakeS3 } from "./fakeS3.helpers";
import { FAKE_STORAGE, asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { managedBucketName } from "../functions/lib/managedStorage";
import { reconcileMigrationObject, type MigrationStore } from "../functions/lib/managedMigration";
import { clearDestination } from "../functions/lib/managedProvisioningFns/targetReady";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Run the readiness step by hand: the one the owner's answer queued is
 * cancelled first, so it cannot run later against another test's buckets.
 */
async function withoutQueuedJobs(t: ReturnType<typeof setupTest>) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
}

const MANAGED_ENDPOINT = "https://managed-account.r2.cloudflarestorage.example";

async function moving(options: {
  phase: "count" | "verify_target";
  claimed: boolean;
  status?: "copying" | "failed";
  errorCode?: string;
  /** Its own bucket per test, so a job one test queued can never reach another's. */
  bucket: string;
}) {
  const t = setupTest();
  const owner = await createUser(t, "midmove-owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "midmove");
  const encrypted = (secret: string) => encryptSecret(secret, requireKeyset(), { workspaceId });
  const sourceBindingId = await t.run(async (ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "r2",
      endpoint: MANAGED_ENDPOINT,
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
      targetBucket: options.bucket,
      targetAccessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedTargetSecretAccessKey: await encrypted(FAKE_STORAGE.secretAccessKey),
      status: options.status ?? "copying",
      errorCode: options.errorCode,
      phase: options.phase,
      objectsCopied: 0,
      objectsProcessedInPhase: 0,
      changesInPass: 0,
      readyToCutover: false,
      targetClaimed: options.claimed,
      startedBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { t, owner, workspaceId, bucket: options.bucket };
}

describe("the move's final check", () => {
  test("keeps a key it did not write, and removes only stale plumbing", async () => {
    const objects = new Map<string, string>([
      ["notes/added-by-hand.md", "theirs"],
      [".context/stale.lock", "ours"],
    ]);
    const store: MigrationStore = {
      async get(key) {
        const body = objects.get(key);
        return body === undefined
          ? null
          : { arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer };
      },
      async put() {
        return {};
      },
      async delete(key) {
        objects.delete(key);
      },
    };
    const empty: MigrationStore = { ...store, get: async () => null };
    for (const key of ["notes/added-by-hand.md", ".context/stale.lock"]) {
      await reconcileMigrationObject({
        source: empty,
        target: store,
        key,
        listedFromTarget: true,
        byteCap: 1024,
        deleteUnmatchedTarget: true,
        deleteOnlyUnder: ".context/",
      });
    }
    expect([...objects.keys()]).toEqual(["notes/added-by-hand.md"]);
  });

  test("a file added by hand while the move runs is kept", async () => {
    const { t, workspaceId, bucket } = await moving({
      phase: "verify_target",
      claimed: true,
      bucket: "added-by-hand-bucket",
    });
    const s3 = fakeS3({
      [managedBucketName(workspaceId)]: { "plan.md": ["the plan", Date.now()] },
      [bucket]: {
        "plan.md": ["the plan", Date.now()],
        "photos/added-by-hand.jpg": ["their photo", Date.now()],
        ".context/stale.lock": ["left by the move", Date.now()],
      },
    });
    await t.action(internal.functions.managedProvisioning.runManagedStorageMigration, {
      workspaceId,
    });
    expect(s3.keys(bucket)).toEqual(["photos/added-by-hand.jpg", "plan.md"]);
  });
});

describe("starting fresh", () => {
  test("start fresh empties the bucket, then claims it", async () => {
    const { t, owner, workspaceId, bucket } = await moving({
      phase: "count",
      claimed: false,
      status: "failed",
      errorCode: "DESTINATION_NOT_EMPTY",
      bucket: "start-fresh-bucket",
    });
    await asUser(t, owner).mutation(api.functions.managedHandoff.chooseExistingFilesForHandoff, {
      workspaceId,
      choice: "replace",
      confirmBucket: bucket,
    });
    await withoutQueuedJobs(t);
    const s3 = fakeS3({
      [managedBucketName(workspaceId)]: {},
      [bucket]: {
        "old/one.md": ["gone once they agreed", Date.now()],
        "old/two.jpg": ["also gone", Date.now()],
      },
    });
    await expect(
      t.action(internal.functions.managedProvisioning.awaitManagedTargetReady, {
        workspaceId,
        retryUntil: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ ready: true });
    expect(s3.keys(bucket)).toEqual([]);
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ targetClaimed: true, existingFiles: "replace" });
  });

  test("a merge deletes nothing up front", async () => {
    const { t, owner, workspaceId, bucket } = await moving({
      phase: "count",
      claimed: false,
      status: "failed",
      errorCode: "DESTINATION_NOT_EMPTY",
      bucket: "merge-bucket",
    });
    await asUser(t, owner).mutation(api.functions.managedHandoff.chooseExistingFilesForHandoff, {
      workspaceId,
      choice: "merge",
    });
    await withoutQueuedJobs(t);
    const s3 = fakeS3({
      [managedBucketName(workspaceId)]: {},
      [bucket]: { "old/one.md": ["theirs", Date.now()] },
    });
    await t.action(internal.functions.managedProvisioning.awaitManagedTargetReady, {
      workspaceId,
      retryUntil: Date.now() + 60_000,
    });
    expect(s3.keys(bucket)).toEqual(["old/one.md"]);
  });

  test("a bucket bigger than one run's budget is not claimed until it is empty", async () => {
    const keys = ["a", "b", "c", "d", "e"];
    const objects = new Set(keys);
    const store = {
      async list({ limit }: { limit?: number }) {
        return {
          objects: [...objects].slice(0, limit).map((key) => ({ key })),
          truncated: objects.size > (limit ?? Infinity),
        };
      },
      async delete(key: string) {
        objects.delete(key);
      },
    };
    await expect(clearDestination(store, { pageSize: 2, maxPages: 2 })).resolves.toBe("more");
    expect(objects.size).toBe(1);
    await expect(clearDestination(store, { pageSize: 2, maxPages: 2 })).resolves.toBe("empty");
    expect(objects.size).toBe(0);
  });

  test("a file that will not go says so rather than trying forever", async () => {
    const store = {
      async list() {
        return { objects: [{ key: "locked.md" }], truncated: false };
      },
      async delete() {},
    };
    await expect(clearDestination(store, { pageSize: 2, maxPages: 5 })).resolves.toBe("stuck");
  });

  test("a bucket that still holds files after a run is not claimed yet", async () => {
    const { t, owner, workspaceId, bucket } = await moving({
      phase: "count",
      claimed: false,
      status: "failed",
      errorCode: "DESTINATION_NOT_EMPTY",
      bucket: "half-empty-bucket",
    });
    await asUser(t, owner).mutation(api.functions.managedHandoff.chooseExistingFilesForHandoff, {
      workspaceId,
      choice: "replace",
      confirmBucket: bucket,
    });
    await withoutQueuedJobs(t);
    fakeS3(
      {
        [managedBucketName(workspaceId)]: {},
        [bucket]: { "held/one.md": ["object lock", Date.now()], "old/two.md": ["goes", Date.now()] },
      },
      { undeletable: ["held/one.md"] },
    );
    await expect(
      t.action(internal.functions.managedProvisioning.awaitManagedTargetReady, {
        workspaceId,
        retryUntil: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ ready: false });
    await withoutQueuedJobs(t);
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({
      targetClaimed: false,
      status: "failed",
      errorCode: "DESTINATION_NOT_CLEARED",
    });
    // The owner can still answer: keep what is there and add on top.
    await asUser(t, owner).mutation(api.functions.managedHandoff.chooseExistingFilesForHandoff, {
      workspaceId,
      choice: "merge",
    });
    await withoutQueuedJobs(t);
    const answered = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(answered).toMatchObject({ status: "copying", existingFiles: "merge" });
  });
});
