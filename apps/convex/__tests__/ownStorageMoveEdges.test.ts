/**
 * The edges of a `to_own` move that share code with the move out of managed
 * storage: a destination that already holds files, the email a paused move
 * sends, and an upgrade to Context's storage started while the move copies.
 *
 * ## Sabotage record
 *
 * Asking `direction === "to_customer"` again in `awaitManagedTargetReady`
 * wrote into a destination that already held the owner's files, failing "a
 * destination with files stops for the owner's answer". The same question in
 * `chooseExistingFilesHandler` refused the answer, failing "merge resumes the
 * move". Dropping `ownMove` from the fail path mailed "Context's storage",
 * failing "the paused email says the storage in use now". Dropping the
 * `ownMoveInProgress` refusal let the upgrade mint a bucket, failing the last
 * test.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { fakeS3 } from "./fakeS3.helpers";
import { FAKE_STORAGE, asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { renderHandoffEmail } from "../functions/lib/managedProvisioningFns/handoffEmail";

afterEach(() => {
  vi.unstubAllGlobals();
});

type T = ReturnType<typeof setupTest>;
const OLD_BUCKET = "edge-old-bucket";
const NEW_BUCKET = "edge-new-bucket";

async function ownMove(options: { plan?: { managedStorage: boolean; status: "none" | "active" } } = {}) {
  const t = setupTest();
  const owner = await createUser(t, "own-move-edge@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "ownmoveedge");
  const sealed = (secret: string) => encryptSecret(secret, requireKeyset(), { workspaceId });
  const sourceBindingId = await t.run(async (ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "r2",
      endpoint: "https://old-account.r2.cloudflarestorage.example",
      region: "auto",
      bucket: OLD_BUCKET,
      accessKeyId: "OLDACCESSKEYID000000",
      encryptedSecretAccessKey: await sealed("old-secret-not-real"),
      status: "connected",
      capabilities: { conditionalWrite: true },
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  if (options.plan !== undefined) {
    await t.run((ctx) =>
      ctx.db.insert("workspacePlans", {
        workspaceId,
        ...options.plan!,
        fastSearch: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }
  await t.run(async (ctx) =>
    ctx.db.insert("managedStorageMigrations", {
      workspaceId,
      sourceBindingId,
      direction: "to_own",
      targetProvider: "r2",
      targetEndpoint: FAKE_STORAGE.endpoint,
      targetRegion: "auto",
      targetBucket: NEW_BUCKET,
      targetAccessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedTargetSecretAccessKey: await sealed(FAKE_STORAGE.secretAccessKey),
      status: "copying",
      phase: "count",
      objectsCopied: 0,
      objectsProcessedInPhase: 0,
      changesInPass: 0,
      readyToCutover: false,
      startedBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { t, owner, workspaceId };
}

async function cancelQueued(t: T) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
}

const ready = (t: T, workspaceId: Id<"workspaces">) =>
  t.action(internal.functions.managedProvisioning.awaitManagedTargetReady, {
    workspaceId,
    retryUntil: Date.now() + 60_000,
  });

describe("a destination that already holds files", () => {
  test("a destination with files stops for the owner's answer, and nothing is written", async () => {
    const { t, workspaceId } = await ownMove();
    await cancelQueued(t);
    const s3 = fakeS3({
      [OLD_BUCKET]: { "plan.md": ["the plan", Date.now()] },
      [NEW_BUCKET]: { "theirs.md": ["already there", Date.now()] },
    });
    await expect(ready(t, workspaceId)).resolves.toEqual({ ready: false });
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ status: "failed", errorCode: "DESTINATION_NOT_EMPTY" });
    expect(s3.keys(NEW_BUCKET)).toEqual(["theirs.md"]);
  });

  test("merge resumes the move and keeps their files", async () => {
    const { t, owner, workspaceId } = await ownMove({ plan: { managedStorage: false, status: "none" } });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("managedStorageMigrations").unique();
      await ctx.db.patch(row!._id, { status: "failed", errorCode: "DESTINATION_NOT_EMPTY" });
    });
    await asUser(t, owner).mutation(api.functions.managedHandoff.chooseExistingFilesForHandoff, {
      workspaceId,
      choice: "merge",
    });
    await cancelQueued(t);
    const s3 = fakeS3({
      [OLD_BUCKET]: { "plan.md": ["the plan", Date.now()] },
      [NEW_BUCKET]: { "theirs.md": ["already there", Date.now()] },
    });
    await expect(ready(t, workspaceId)).resolves.toEqual({ ready: true });
    expect(s3.keys(NEW_BUCKET)).toEqual(["theirs.md"]);
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ status: "copying", existingFiles: "merge" });
    // Answering is not Context's storage starting up: the plan is untouched.
    const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
    expect(plan?.managedProvisioning).toBeUndefined();
  });

  test("start fresh empties the destination after the owner types its name", async () => {
    const { t, owner, workspaceId } = await ownMove();
    await t.run(async (ctx) => {
      const row = await ctx.db.query("managedStorageMigrations").unique();
      await ctx.db.patch(row!._id, { status: "failed", errorCode: "DESTINATION_NOT_EMPTY" });
    });
    await asUser(t, owner).mutation(api.functions.managedHandoff.chooseExistingFilesForHandoff, {
      workspaceId,
      choice: "replace",
      confirmBucket: NEW_BUCKET,
    });
    await cancelQueued(t);
    const s3 = fakeS3({
      [OLD_BUCKET]: { "plan.md": ["the plan", Date.now()] },
      [NEW_BUCKET]: { "theirs.md": ["gone once they agreed", Date.now()] },
    });
    await expect(ready(t, workspaceId)).resolves.toEqual({ ready: true });
    expect(s3.keys(NEW_BUCKET)).toEqual([]);
    // The old storage is never what start fresh empties.
    expect(s3.keys(OLD_BUCKET)).toEqual(["plan.md"]);
  });
});

describe("the paused email", () => {
  test("the paused email says the storage in use now, never Context's storage", async () => {
    const { t, workspaceId, owner } = await ownMove();
    await cancelQueued(t);
    await t.mutation(internal.functions.managedProvisioning.failManagedStorageMigration, {
      workspaceId,
      errorCode: "COPY_FAILED",
    });
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const mail = jobs.filter((job) => job.name.includes("sendHandoffEmail"));
    expect(mail.map((job) => job.args[0])).toEqual([
      { workspaceId, recipientUserId: owner, kind: "paused", ownMove: true },
    ]);
    const rendered = renderHandoffEmail("paused", { workspaceName: "ownmoveedge", url: null, ownMove: true });
    expect(rendered.text).toContain("the storage it uses now");
    expect(rendered.text).not.toContain("Context's storage");
  });
});

describe("an upgrade started while the owner's move copies", () => {
  test("the upgrade refuses before minting anything, and says why", async () => {
    const { t, workspaceId } = await ownMove({ plan: { managedStorage: true, status: "active" } });
    await cancelQueued(t);
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(String(url));
      return new Response("{}", { status: 500 });
    });
    await expect(
      t.action(internal.functions.managedProvisioning.provisionManagedStorage, { workspaceId }),
    ).resolves.toEqual({ ok: false, errorCode: "MOVE_IN_PROGRESS" });
    expect(requests).toEqual([]);
    const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
    expect(plan).toMatchObject({ managedProvisioning: "failed", managedProvisioningError: "MOVE_IN_PROGRESS" });
    // The owner's move is still theirs, still copying, still into their bucket.
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(row).toMatchObject({ direction: "to_own", status: "copying", targetBucket: NEW_BUCKET });
  });
});
