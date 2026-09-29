/**
 * A destination that already has files: start fresh, or merge on top.
 *
 * Context sees the whole bucket and never a folder of it (owner, 2026-09-29),
 * so a bucket with files in it is not a dead end. Starting fresh deletes what
 * is there, and only after the owner types the bucket's name. Merging keeps
 * every file of theirs; a file that shares a name with one of the workspace's
 * is kept beside it as `name (from your bucket).ext`.
 *
 * ## Sabotage record
 *
 * Dropping the typed-name check let "start fresh" resume with any text, failing
 * the first test. Letting a merge claim the destination made its verify pass
 * eligible to delete their files, failing "merging keeps every file". Removing
 * the `keepTargetConflicts` copy overwrote their file, failing the last test.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  FAKE_STORAGE,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { managedBucketName } from "../functions/lib/managedStorage";
import {
  conflictCopyKey,
  reconcileMigrationObject,
  type MigrationStore,
} from "../functions/lib/managedMigration";

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

async function waitingForChoice() {
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
      status: "failed",
      errorCode: "DESTINATION_NOT_EMPTY",
      phase: "count",
      objectsCopied: 0,
      objectsProcessedInPhase: 0,
      changesInPass: 0,
      readyToCutover: false,
      targetClaimed: false,
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

describe("a destination that already has files", () => {
  test("starting fresh needs the bucket's name typed, then claims the bucket", async () => {
    const { t, owner, workspaceId } = await waitingForChoice();
    const choose = (confirmBucket: string) =>
      asUser(t, owner).mutation(api.functions.managedHandoff.chooseExistingFilesForHandoff, {
        workspaceId,
        choice: "replace",
        confirmBucket,
      });

    expect(errorCode(await captureError(() => choose("customer")))).toBe("CONFIRMATION_MISMATCH");
    const refused = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(refused).toMatchObject({ status: "failed", errorCode: "DESTINATION_NOT_EMPTY" });

    await expect(choose("customer-bucket")).resolves.toEqual({ resumed: true });
    stubDestination(["photos/beach.jpg"]);
    await expect(
      t.action(internal.functions.managedProvisioning.awaitManagedTargetReady, {
        workspaceId,
        retryUntil: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ ready: true });
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ status: "copying", existingFiles: "replace", targetClaimed: true });
    expect(await scheduled(t, "runManagedStorageMigration")).toBe(true);
  });

  test("merging keeps every file: the move starts and the destination is never claimed", async () => {
    const { t, owner, workspaceId } = await waitingForChoice();
    await asUser(t, owner).mutation(api.functions.managedHandoff.chooseExistingFilesForHandoff, {
      workspaceId,
      choice: "merge",
    });
    const destination = stubDestination(["photos/beach.jpg"]);
    await expect(
      t.action(internal.functions.managedProvisioning.awaitManagedTargetReady, {
        workspaceId,
        retryUntil: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ ready: true });
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ status: "copying", existingFiles: "merge" });
    expect(row?.targetClaimed).not.toBe(true);
    // The readiness probe cleans up after itself; nothing of theirs is touched.
    expect(destination.deletes).not.toContain("photos/beach.jpg");
    expect(destination.objects.has("photos/beach.jpg")).toBe(true);
    const view = await asUser(t, owner).query(api.functions.storage.getStorageBinding, {
      workspaceId,
    });
    expect(view?.handoffExistingFiles).toBe("merge");
  });

  test("a move not waiting for an answer is not resumed by one", async () => {
    const { t, owner, workspaceId } = await waitingForChoice();
    await t.run(async (ctx) => {
      const row = await ctx.db.query("managedStorageMigrations").unique();
      await ctx.db.patch(row!._id, { errorCode: "COPY_FAILED" });
    });
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, owner).mutation(api.functions.managedHandoff.chooseExistingFilesForHandoff, {
            workspaceId,
            choice: "merge",
          }),
        ),
      ),
    ).toBe("NOT_WAITING_FOR_CHOICE");
  });

  test("a merged file with a shared name is kept beside the workspace's, once", async () => {
    const memory = (objects: Map<string, string>): MigrationStore => ({
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
        objects.delete(key);
      },
    });
    const sourceObjects = new Map([["notes/plan.md", "ours"]]);
    const targetObjects = new Map([["notes/plan.md", "theirs"]]);
    const reconcile = () =>
      reconcileMigrationObject({
        source: memory(sourceObjects),
        target: memory(targetObjects),
        key: "notes/plan.md",
        listedFromTarget: false,
        byteCap: 1024,
        deleteUnmatchedTarget: false,
        keepTargetConflicts: true,
      });

    await reconcile();
    expect(targetObjects.get("notes/plan.md")).toBe("ours");
    expect(targetObjects.get("notes/plan (from your bucket).md")).toBe("theirs");

    sourceObjects.set("notes/plan.md", "ours, edited");
    await reconcile();
    expect(targetObjects.get("notes/plan (from your bucket).md")).toBe("theirs");
    expect(conflictCopyKey("README")).toBe("README (from your bucket)");
    expect(conflictCopyKey("a.b/notes")).toBe("a.b/notes (from your bucket)");
  });
});
