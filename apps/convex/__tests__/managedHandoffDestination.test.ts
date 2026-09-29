/**
 * Moving out of managed storage never touches files the customer already had.
 *
 * The move's last pass makes the destination match the managed source, which
 * includes deleting destination keys the source does not have. Into a bucket
 * that already held the customer's own files, that deleted them. So the
 * destination is asked once, before the first write, whether it holds
 * anything; a destination that does is refused with `DESTINATION_NOT_EMPTY`,
 * and only a destination checked empty (`targetClaimed`) may lose keys later.
 *
 * ## Sabotage record
 *
 * Forcing `destinationHoldsObjects` to answer `false` made the occupied-bucket
 * case schedule the copy and claim the destination, failing the first test on
 * `errorCode`. Ignoring `deleteUnmatchedTarget` in `reconcileMigrationObject`
 * made the unclaimed verify pass delete the customer's key, failing the last
 * test.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  FAKE_STORAGE,
  asUser,
  createUser,
  createWorkspace,
  setupTest,
} from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { managedBucketName } from "../functions/lib/managedStorage";
import { reconcileMigrationObject, type MigrationStore } from "../functions/lib/managedMigration";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An S3 endpoint holding `keys`, recording every request it answers. */
function stubDestination(keys: string[]) {
  const state = { deletes: [] as string[], objects: new Set(keys) };
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    const key = decodeURIComponent(new URL(url).pathname.slice(1).split("/").slice(1).join("/"));
    if (method === "DELETE") {
      state.deletes.push(key);
      state.objects.delete(key);
      return { ok: true, status: 204, text: async () => "", headers: new Headers() };
    }
    if (method === "PUT") {
      state.objects.add(key);
      return { ok: true, status: 200, text: async () => "", headers: new Headers({ etag: '"abc"' }) };
    }
    if (method === "GET" && url.includes("list-type=2")) {
      const contents = [...state.objects]
        .filter((listed) => !listed.startsWith(".context/"))
        .map((listed) => `<Contents><Key>${listed}</Key><Size>5</Size></Contents>`)
        .join("");
      return {
        ok: true,
        status: 200,
        text: async () =>
          `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        headers: new Headers(),
      };
    }
    return { ok: true, status: 200, text: async () => "probe", headers: new Headers({ etag: '"abc"' }) };
  });
  return state;
}

async function handingOff(options: { targetClaimed?: boolean } = {}) {
  const t = setupTest();
  const owner = await createUser(t, "leaving-owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "leaving");
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
      targetEndpoint: "https://customer.r2.cloudflarestorage.example",
      targetRegion: "auto",
      targetBucket: "customer-bucket",
      targetAccessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedTargetSecretAccessKey: await encrypted(FAKE_STORAGE.secretAccessKey),
      status: "copying",
      phase: "count",
      objectsCopied: 0,
      objectsProcessedInPhase: 0,
      changesInPass: 0,
      readyToCutover: false,
      targetClaimed: options.targetClaimed,
      startedBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { t, owner, workspaceId, sourceBindingId };
}

async function scheduled(t: ReturnType<typeof setupTest>, name: string) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.some((job) => job.name.includes(name));
}

describe("moving out of managed storage into a customer's bucket", () => {
  test("a destination that already holds files is refused before anything is written", async () => {
    const { t, workspaceId, sourceBindingId } = await handingOff();
    const destination = stubDestination(["photos/beach.jpg", "backups/db.sql"]);

    await expect(
      t.action(internal.functions.managedProvisioning.awaitManagedTargetReady, {
        workspaceId,
        retryUntil: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ ready: false });

    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ status: "failed", errorCode: "DESTINATION_NOT_EMPTY" });
    expect(row?.targetClaimed).not.toBe(true);
    expect(await scheduled(t, "runManagedStorageMigration")).toBe(false);
    expect(destination.objects.has("photos/beach.jpg")).toBe(true);
    expect(destination.objects.has("backups/db.sql")).toBe(true);
    // The live source is exactly where it was.
    const binding = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    expect(binding?._id).toBe(sourceBindingId);
  });

  test("an empty destination is claimed and the copy starts", async () => {
    const { t, workspaceId } = await handingOff();
    stubDestination([]);

    await expect(
      t.action(internal.functions.managedProvisioning.awaitManagedTargetReady, {
        workspaceId,
        retryUntil: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ ready: true });

    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ status: "copying", targetClaimed: true });
    expect(await scheduled(t, "runManagedStorageMigration")).toBe(true);
  });

  test("a retry into the same claimed destination carries on; another bucket is asked again", async () => {
    const { t, owner, workspaceId } = await handingOff({ targetClaimed: true });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("managedStorageMigrations").unique();
      await ctx.db.patch(row!._id, {
        status: "failed",
        errorCode: "COPY_FAILED",
        targetEndpoint: "https://accountid.r2.cloudflarestorage.example",
        targetBucket: FAKE_STORAGE.bucket,
      });
    });

    await asUser(t, owner).action(api.functions.storage.startManagedStorageHandoff, {
      workspaceId,
      ...FAKE_STORAGE,
    });
    const retried = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(retried).toMatchObject({ status: "copying", targetClaimed: true });

    await asUser(t, owner).action(api.functions.storage.startManagedStorageHandoff, {
      workspaceId,
      ...FAKE_STORAGE,
      bucket: "a-different-bucket",
    });
    const moved = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(moved).toMatchObject({ targetBucket: "a-different-bucket", targetClaimed: false });
  });

  test("an unclaimed destination never loses a key the source lacks", async () => {
    const deleted: string[] = [];
    const store = (objects: Map<string, string>): MigrationStore => ({
      get: async (key) => {
        const body = objects.get(key);
        return body === undefined
          ? null
          : { arrayBuffer: async () => new TextEncoder().encode(body).buffer };
      },
      put: async (key, value) => {
        objects.set(key, new TextDecoder().decode(value));
      },
      delete: async (key) => {
        deleted.push(key);
        objects.delete(key);
      },
    });
    const source = store(new Map());
    const target = store(new Map([["photos/beach.jpg", "theirs"]]));

    await expect(
      reconcileMigrationObject({
        source,
        target,
        key: "photos/beach.jpg",
        listedFromTarget: true,
        byteCap: 1024,
        deleteUnmatchedTarget: false,
      }),
    ).resolves.toEqual({ copied: 0, changes: 0 });
    expect(deleted).toEqual([]);

    await reconcileMigrationObject({
      source,
      target,
      key: "photos/beach.jpg",
      listedFromTarget: true,
      byteCap: 1024,
      deleteUnmatchedTarget: true,
    });
    expect(deleted).toEqual(["photos/beach.jpg"]);
  });
});
