/**
 * `/gateway/binding` carries managed-storage encryption's mode, as a sibling.
 *
 * The gateway seals and opens (`apps/mcp/src/store/managedEncryption.js`);
 * this proves the control plane tells it to: the mode beside the binding, the
 * key in `encryptionKey`, nothing for a bucket the customer owns, and no
 * binding at all when the mode cannot be read.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *  - `openStorageBinding` answering a failed mode lookup as plain: 1 failure.
 *  - `openStorageBinding` dropping the sibling: 2 failures.
 */

import { describe, expect, test, vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import {
  createUser,
  createWorkspace,
  gatewayPost,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { CLIENT_A, bodyOf, registerClient, seedConnectedClient, token } from "./fixtures.helpers";

async function connected(t: TestConvex, slug: string, managed: boolean) {
  const user = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, user, slug);
  await seedStorageBinding(t, {
    workspaceId,
    boundBy: user,
    ...(managed ? { bucket: managedBucketName(workspaceId) } : {}),
  });
  await registerClient(t, CLIENT_A);
  const accessToken = token(`${slug}_owner`);
  await seedConnectedClient(t, { workspaceId, userId: user, clientId: CLIENT_A, accessToken });
  return { workspaceId: workspaceId as Id<"workspaces">, accessToken };
}

async function open(t: TestConvex, accessToken: string) {
  return await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken, expectedWorkspaceId: null }));
}

async function encrypting(t: TestConvex, workspaceId: Id<"workspaces">, state: "encrypting" | "encrypted") {
  await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId, create: true });
  await t.run((ctx) =>
    ctx.db.insert("managedEncryptionWorkspaces", {
      workspaceId,
      state,
      filesDone: 0,
      runId: 0,
      updatedAt: Date.now(),
    }),
  );
}

describe("/gateway/binding and managed-storage encryption", () => {
  test("a managed bucket being encrypted is sent its mode and its key, beside the binding", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await connected(t, "sealing", true);
    await encrypting(t, workspaceId, "encrypting");
    const body = await open(t, accessToken);
    expect(body.managedEncryption).toEqual({ mode: "migrating" });
    expect((body.encryptionKey as { current: string }).current).toBe("k1");
    expect((body.binding as Record<string, unknown>).managedEncryption).toBeUndefined();
  });

  test("encrypted is sent as encrypted", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await connected(t, "sealed", true);
    await encrypting(t, workspaceId, "encrypted");
    expect((await open(t, accessToken)).managedEncryption).toEqual({ mode: "encrypted" });
  });

  test("a bucket the customer owns never gets a mode, even with a stale row", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await connected(t, "owned", false);
    await encrypting(t, workspaceId, "encrypted");
    const body = await open(t, accessToken);
    expect(body.binding).toBeTruthy();
    expect("managedEncryption" in body).toBe(false);
  });

  test("a mode that cannot be read is no binding, never a plain one", async () => {
    const t = setupTest();
    const { workspaceId, accessToken } = await connected(t, "unread", true);
    await encrypting(t, workspaceId, "encrypted");
    const state = await import("../../functions/lib/managedEncryptionFns/state");
    const spy = vi.spyOn(state, "gatewayModeForWorkspace").mockRejectedValue(new Error("down"));
    try {
      const body = await open(t, accessToken);
      expect(body.binding ?? null).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
