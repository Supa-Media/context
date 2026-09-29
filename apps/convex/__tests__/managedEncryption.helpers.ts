/**
 * The shared fixture for the managed-encryption tests: a staff user who owns
 * one managed workspace ("ours"), an owner with a member on another ("theirs"),
 * and an S3 stub standing in for our managed bucket, holding three plain notes.
 */

import { afterEach, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { managedBucketName } from "../functions/lib/managedStorage";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { addMember, createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";
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
