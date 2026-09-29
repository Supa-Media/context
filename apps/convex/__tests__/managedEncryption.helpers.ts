/**
 * The shared fixture for the managed-encryption tests: a staff user who owns
 * one managed workspace ("ours"), an owner with a member on another ("theirs"),
 * and an S3 stub standing in for our managed bucket, holding three plain notes.
 */

import { afterEach, expect, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { managedBucketName } from "../functions/lib/managedStorage";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { addMember, asUser, createUser, createWorkspace, drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";

type CatchUpArgs = FunctionArgs<typeof internal.functions.moveCatchUp.runMoveCatchUp>;
import { memoryS3, type MemoryS3Options } from "./storeStub.helpers";

export const ADMIN = "staff@example.invalid";
export const MAGIC = new TextEncoder().encode("CTXENC");

export function resetAfterEach() {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env[ADMIN_EMAILS_ENV_VAR];
  });
}

export async function bindManaged(t: TestConvex, workspaceId: Id<"workspaces">, owner: Id<"users">) {
  const encryptedSecretAccessKey = await encryptSecret("managed-secret-not-real", requireKeyset(), {
    workspaceId,
  });
  await t.run((ctx) =>
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
}

export async function fixture(options: MemoryS3Options = {}) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const t = setupTest();
  const staff = await createUser(t, ADMIN);
  const owner = await createUser(t, "owner@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");
  const theirs = await createWorkspace(t, owner, "theirs");
  await addMember(t, theirs, member, "member", owner);
  const ours = await createWorkspace(t, staff, "ours");
  await bindManaged(t, theirs, owner);
  await bindManaged(t, ours, staff);

  const backend = memoryS3(managedBucketName(ours), options);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Ours\n");
  backend.seed("1-projects/plan.md", "# Plan\n\nThe words people typed.\n");
  vi.stubGlobal("fetch", backend.fetchImpl);
  return { t, staff, owner, member, stranger, theirs, ours, backend };
}

export function isSealed(bytes: Uint8Array | null): boolean {
  return bytes !== null && MAGIC.every((byte, i) => bytes[i] === byte);
}

export async function row(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("managedEncryptionWorkspaces")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );
}


/** The key generation an envelope names: magic, version, length, generation. */
export function generationOf(bytes: Uint8Array | null): string | null {
  if (!isSealed(bytes)) return null;
  const length = bytes![7];
  return new TextDecoder().decode(bytes!.slice(8, 8 + length));
}

export const MANAGED_ENDPOINT = "https://managed-account.r2.cloudflarestorage.example";

export async function bindingOf(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );
}

/** A copy that has reached its last, quiet pass, ready to switch. */
export async function readyMigration(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  startedBy: Id<"users">,
  to: { direction: "to_customer" | "to_managed"; bucket: string; endpoint: string },
) {
  const source = await bindingOf(t, workspaceId);
  const encryptedTargetSecretAccessKey = await encryptSecret("target-secret-not-real", requireKeyset(), {
    workspaceId,
  });
  await t.run((ctx) =>
    ctx.db.insert("managedStorageMigrations", {
      workspaceId,
      sourceBindingId: source!._id,
      direction: to.direction,
      targetProvider: "r2",
      targetEndpoint: to.endpoint,
      targetRegion: "auto",
      targetBucket: to.bucket,
      targetAccessKeyId: "target-key-id",
      encryptedTargetSecretAccessKey,
      status: "copying",
      phase: "verify_target",
      objectsCopied: 3,
      changesInPass: 0,
      readyToCutover: true,
      startedBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

export async function managedPlan(t: TestConvex, workspaceId: Id<"workspaces">) {
  await t.run((ctx) =>
    ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
      status: "active",
      managedProvisioning: "ready",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/**
 * The week-later deletion and the move's catch-up passes are not what most
 * of these tests are about: drop them, and hand back the first catch-up
 * pass's arguments for the tests that run it by hand.
 */
export async function cancelLaterJobs(t: TestConvex): Promise<CatchUpArgs | null> {
  return await t.run(async (ctx) => {
    let catchUp: CatchUpArgs | null = null;
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind !== "pending") continue;
      if (job.name.includes("runMoveCatchUp")) catchUp ??= job.args[0] as CatchUpArgs;
      if (job.name.includes("deleteManagedStorageAfterHandoff") || job.name.includes("runMoveCatchUp")) {
        await ctx.scheduler.cancel(job._id);
      }
    }
    return catchUp;
  });
}

export async function encryptedThenMovedOut() {
  const f = await fixture();
  const { t, staff, ours } = f;
  await managedPlan(t, ours);
  await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
  await drainScheduled(t);
  expect(await row(t, ours)).toMatchObject({ state: "encrypted" });

  await readyMigration(t, ours, staff, {
    direction: "to_customer",
    bucket: "customer-owned-context",
    endpoint: "https://customer.example.invalid",
  });
  await expect(
    t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, { workspaceId: ours }),
  ).resolves.toEqual({ cutover: true });
  const catchUp = await cancelLaterJobs(t);
  return { ...f, catchUp };
}
