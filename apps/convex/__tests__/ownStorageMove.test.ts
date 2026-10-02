/**
 * Moving a workspace from one bucket its owner holds to another.
 *
 * The third direction of the storage-move engine (`to_own`, see
 * `docs/design/own-storage-moves`). The promises: every file arrives and is
 * verified before the switch, the old bucket is never touched (it is the
 * owner's, and they delete it when they choose), the plan row is never
 * written (this move has nothing to do with Context's storage, and a free
 * workspace may have none), and nothing else may change the storage while
 * the move runs.
 *
 * ## Sabotage record
 *
 * Removing the owner check in `beginOwnStorageMoveHandler` failed "is
 * owner-only"; skipping the same-bucket comparison failed "refuses the bucket
 * the workspace already uses"; skipping the managed-source refusal failed
 * "refuses a workspace on Context's storage". Dropping `refuseDuringMove` from
 * `applyBinding` and from disconnect failed the two "is refused" tests.
 * Letting a failed or stopped `to_own` move write the plan row failed "a
 * failed page writes no plan state" and "a stop leaves the old bucket live".
 * Reporting every row's status to the upgrade failed "an upgrade to Context's
 * storage does not pick up the owner's move".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { fakeS3 } from "./fakeS3.helpers";
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

afterEach(() => {
  vi.unstubAllGlobals();
});

const OLD_BUCKET = "old-own-bucket";
const NEW_BUCKET = "new-own-bucket";
const OLD_ENDPOINT = "https://old-account.r2.cloudflarestorage.example";

type T = ReturnType<typeof setupTest>;

async function ownBucketContext(options: { plan?: boolean } = {}) {
  const t = setupTest();
  const owner = await createUser(t, "own-move-owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "ownmove");
  const sourceBindingId = await t.run(async (ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "r2",
      endpoint: OLD_ENDPOINT,
      region: "auto",
      bucket: OLD_BUCKET,
      accessKeyId: "OLDACCESSKEYID000000",
      encryptedSecretAccessKey: await encryptSecret("old-secret-not-real", requireKeyset(), {
        workspaceId,
      }),
      status: "connected",
      capabilities: { conditionalWrite: true },
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  if (options.plan === true) {
    await t.run((ctx) =>
      ctx.db.insert("workspacePlans", {
        workspaceId,
        managedStorage: false,
        fastSearch: false,
        status: "none",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }
  return { t, owner, workspaceId, sourceBindingId };
}

function move(t: T, owner: Id<"users">, workspaceId: Id<"workspaces">, overrides = {}) {
  return asUser(t, owner).action(api.functions.storage.startStorageMove, {
    workspaceId,
    ...FAKE_STORAGE,
    bucket: NEW_BUCKET,
    ...overrides,
  });
}

async function cancelQueued(t: T) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
}

/** Run the move's scheduled steps by hand until it switches over or stops. */
async function driveToEnd(t: T, workspaceId: Id<"workspaces">) {
  await cancelQueued(t);
  await t.action(internal.functions.managedProvisioning.awaitManagedTargetReady, {
    workspaceId,
    retryUntil: Date.now() + 60_000,
  });
  for (let step = 0; step < 20; step += 1) {
    await cancelQueued(t);
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    if (row === null || row.status !== "copying") return row;
    await t.action(internal.functions.managedProvisioning.runManagedStorageMigration, {
      workspaceId,
    });
  }
  throw new Error("the move did not finish in 20 steps");
}

describe("starting a move between the owner's own buckets", () => {
  test("parks a sealed destination and leaves the old bucket live", async () => {
    const { t, owner, workspaceId, sourceBindingId } = await ownBucketContext();
    await expect(move(t, owner, workspaceId)).resolves.toEqual({ started: true });

    const binding = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    expect(binding?._id).toBe(sourceBindingId);
    expect(binding?.bucket).toBe(OLD_BUCKET);

    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({
      workspaceId,
      sourceBindingId,
      direction: "to_own",
      targetBucket: NEW_BUCKET,
      status: "copying",
      phase: "count",
    });
    expect(JSON.stringify(row)).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(
      await decryptSecret(row!.encryptedTargetSecretAccessKey, requireKeyset(), { workspaceId }),
    ).toBe(FAKE_STORAGE.secretAccessKey);
  });

  test("never writes a plan row, and leaves an existing one alone", async () => {
    const free = await ownBucketContext();
    await move(free.t, free.owner, free.workspaceId);
    expect(await free.t.run((ctx) => ctx.db.query("workspacePlans").collect())).toEqual([]);

    const withPlan = await ownBucketContext({ plan: true });
    await move(withPlan.t, withPlan.owner, withPlan.workspaceId);
    const plan = await withPlan.t.run((ctx) => ctx.db.query("workspacePlans").unique());
    expect(plan?.managedProvisioning).toBeUndefined();
  });

  test("is owner-only", async () => {
    const { t, owner, workspaceId } = await ownBucketContext();
    for (const role of ["editor", "member"] as const) {
      const other = await createUser(t, `own-move-${role}@example.invalid`);
      await addMember(t, workspaceId, other, role, owner);
      expect(errorCode(await captureError(() => move(t, other, workspaceId)))).toBe(
        "INSUFFICIENT_ROLE",
      );
    }
    expect(await t.run((ctx) => ctx.db.query("managedStorageMigrations").collect())).toEqual([]);
  });

  test("refuses the bucket the workspace already uses", async () => {
    const { t, owner, workspaceId } = await ownBucketContext();
    const code = errorCode(
      await captureError(() =>
        move(t, owner, workspaceId, { endpoint: `${OLD_ENDPOINT}/`, bucket: OLD_BUCKET }),
      ),
    );
    expect(code).toBe("SAME_STORAGE");
  });

  test("refuses a workspace on Context's storage, which has its own way out", async () => {
    const { t, owner, workspaceId } = await ownBucketContext();
    await t.run(async (ctx) => {
      const binding = await ctx.db.query("storageBindings").unique();
      await ctx.db.patch(binding!._id, { bucket: managedBucketName(workspaceId) });
    });
    expect(errorCode(await captureError(() => move(t, owner, workspaceId)))).toBe(
      "MANAGED_STORAGE",
    );
  });

  test("refuses a second move while one is running", async () => {
    const { t, owner, workspaceId } = await ownBucketContext();
    await move(t, owner, workspaceId);
    expect(
      errorCode(await captureError(() => move(t, owner, workspaceId, { bucket: "third-bucket" }))),
    ).toBe("MOVE_IN_PROGRESS");
  });
});

describe("the move itself", () => {
  test("copies every file, switches, and never touches the old bucket", async () => {
    const { t, owner, workspaceId, sourceBindingId } = await ownBucketContext();
    const s3 = fakeS3({
      [OLD_BUCKET]: {
        "index.md": ["front page", Date.now()],
        "1-projects/plan.md": ["the plan", Date.now()],
        ".context/history/plan.bin": ["history", Date.now()],
      },
      [NEW_BUCKET]: {},
    });
    await move(t, owner, workspaceId);
    expect(await driveToEnd(t, workspaceId)).toBeNull();

    expect(s3.keys(NEW_BUCKET)).toEqual([".context/history/plan.bin", "1-projects/plan.md", "index.md"]);
    // The old bucket: every key still there, nothing deleted or rewritten.
    expect(s3.keys(OLD_BUCKET)).toEqual([".context/history/plan.bin", "1-projects/plan.md", "index.md"]);
    expect(s3.requests.filter((request) => request.includes(`${OLD_BUCKET}/`) && !request.startsWith("GET") && !request.startsWith("HEAD"))).toEqual([]);

    // The same binding row, now pointing at the new bucket.
    const binding = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    expect(binding).toMatchObject({ _id: sourceBindingId, bucket: NEW_BUCKET, status: "connected" });

    const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.some((event) => event.action === "storage.moved")).toBe(true);
    // The late-write passes are queued, with the old key still sealed.
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some((job) => job.name.includes("runMoveCatchUp"))).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("workspacePlans").collect())).toEqual([]);
  });

  test("a stop leaves the old bucket live and writes no plan state", async () => {
    const { t, owner, workspaceId, sourceBindingId } = await ownBucketContext({ plan: true });
    await move(t, owner, workspaceId);
    await expect(
      asUser(t, owner).mutation(api.functions.managedHandoff.cancelManagedStorageHandoff, {
        workspaceId,
      }),
    ).resolves.toEqual({ cancelled: true });
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ status: "failed", errorCode: "CANCELLED" });
    const binding = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    expect(binding?._id).toBe(sourceBindingId);
    const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
    expect(plan?.managedProvisioning).toBeUndefined();
  });

  test("a failed page writes no plan state", async () => {
    const { t, owner, workspaceId } = await ownBucketContext({ plan: true });
    await move(t, owner, workspaceId);
    await t.mutation(internal.functions.managedProvisioning.failManagedStorageMigration, {
      workspaceId,
      errorCode: "COPY_FAILED",
    });
    const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
    expect(plan?.managedProvisioning).toBeUndefined();
  });
});

describe("nothing else changes the storage while a move runs", () => {
  test("connecting other storage is refused", async () => {
    const { t, owner, workspaceId } = await ownBucketContext();
    await move(t, owner, workspaceId);
    const code = errorCode(
      await captureError(() =>
        asUser(t, owner).action(api.functions.storage.bindStorage, {
          workspaceId,
          ...FAKE_STORAGE,
          bucket: "somewhere-else",
        }),
      ),
    );
    expect(code).toBe("MOVE_IN_PROGRESS");
  });

  test("disconnecting is refused", async () => {
    const { t, owner, workspaceId } = await ownBucketContext();
    await move(t, owner, workspaceId);
    const code = errorCode(
      await captureError(() =>
        asUser(t, owner).mutation(api.functions.storage.disconnectStorage, { workspaceId }),
      ),
    );
    expect(code).toBe("MOVE_IN_PROGRESS");
  });

  test("an upgrade to Context's storage does not pick up the owner's move", async () => {
    const { t, owner, workspaceId } = await ownBucketContext();
    await move(t, owner, workspaceId);
    const standing = await t.query(internal.functions.managedProvisioning.provisioningStanding, {
      workspaceId,
    });
    // The upgrade must not see this row as a move into managed storage to resume.
    expect(standing?.migrationStatus).toBeUndefined();
    expect(standing?.ownMoveInProgress).toBe(true);
  });
});
