/**
 * Storage bindings.
 *
 * The two things that must hold no matter what changes here:
 *  - the secret access key is never stored in the clear, and
 *  - no public function returns it, in any form, to anyone.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  bindFakeStorage,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

async function boundWorkspace() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  await bindFakeStorage(t, owner, workspaceId);
  return { t, owner, workspaceId };
}

describe("bindStorage", () => {
  test("stores the secret encrypted, never in the clear", async () => {
    const { t, workspaceId } = await boundWorkspace();

    const binding = await t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );

    expect(binding).not.toBeNull();
    expect(binding!.encryptedSecretAccessKey).not.toContain(
      FAKE_STORAGE.secretAccessKey,
    );
    expect(binding!.encryptedSecretAccessKey.startsWith("v1:")).toBe(true);
    // The whole row, serialized, must not contain the plaintext anywhere.
    expect(JSON.stringify(binding)).not.toContain(FAKE_STORAGE.secretAccessKey);
  });

  test("belongs to the workspace, not to the user who pasted it", async () => {
    const { t, workspaceId } = await boundWorkspace();
    const binding = await t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    expect(binding!.workspaceId).toBe(workspaceId);
    expect(Object.keys(binding!)).not.toContain("userId");
  });

  test("starts unverified and without claiming conditional-write support", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding).toMatchObject({
      status: "unverified",
      capabilities: { conditionalWrite: false },
    });
    expect(binding?.lastVerifiedAt).toBeUndefined();
  });

  test("rebinding replaces the single binding rather than accumulating rows", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await bindFakeStorage(t, owner, workspaceId, { bucket: "second-bucket" });

    const bindings = await t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0].bucket).toBe("second-bucket");
  });

  test("rebinding clears a stale verification rather than showing a green check for a new bucket", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: true },
    });
    expect(
      (
        await asUser(t, owner).query(api.functions.storage.getStorageBinding, {
          workspaceId,
        })
      )?.status,
    ).toBe("connected");

    await bindFakeStorage(t, owner, workspaceId, { bucket: "different-bucket" });

    const rebound = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(rebound).toMatchObject({
      status: "unverified",
      capabilities: { conditionalWrite: false },
    });
    expect(rebound?.lastVerifiedAt).toBeUndefined();
  });

  test("rejects a non-https endpoint, so a credential is never signed over plaintext", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");

    expect(
      errorCode(
        await captureError(() =>
          bindFakeStorage(t, owner, workspaceId, {
            endpoint: "http://insecure.example/",
          }),
        ),
      ),
    ).toBe("INVALID_ENDPOINT");
    expect(
      errorCode(
        await captureError(() =>
          bindFakeStorage(t, owner, workspaceId, { endpoint: "not-a-url" }),
        ),
      ),
    ).toBe("INVALID_ENDPOINT");
  });

  test("rejects credentials embedded in the endpoint URL", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");

    expect(
      errorCode(
        await captureError(() =>
          bindFakeStorage(t, owner, workspaceId, {
            endpoint: "https://key:secret@storage.example/",
          }),
        ),
      ),
    ).toBe("INVALID_ENDPOINT");
  });

  test("normalizes a root prefix and refuses traversal in it", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");

    await bindFakeStorage(t, owner, workspaceId, { rootPrefix: "/notes/brain/" });
    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.rootPrefix).toBe("notes/brain/");

    expect(
      errorCode(
        await captureError(() =>
          bindFakeStorage(t, owner, workspaceId, { rootPrefix: "../escape" }),
        ),
      ),
    ).toBe("INVALID_ROOT_PREFIX");
  });

  test("requires authentication", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");

    const error = await captureError(() =>
      t.action(api.functions.storage.bindStorage, {
        workspaceId,
        ...FAKE_STORAGE,
      }),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });
});

describe("no public function returns a decrypted secret", () => {
  test("getStorageBinding returns neither the plaintext nor the envelope", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    const serialized = JSON.stringify(binding);

    expect(serialized).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(serialized).not.toContain("encryptedSecretAccessKey");
    expect(serialized).not.toContain("v1:");
    // Even the access key id — half a credential — comes back masked.
    expect(serialized).not.toContain(FAKE_STORAGE.accessKeyId);
    expect(binding?.maskedAccessKeyId.endsWith("ID00")).toBe(true);
  });

  test("the owner cannot read their own secret back either", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(Object.keys(binding ?? {})).not.toContain("secretAccessKey");
  });

  /**
   * A structural check, not a behavioural one: enumerate every public function
   * in `functions/storage.ts` and assert that the only decrypting entry point
   * is not among them. If someone adds a public `getCredentials`, this fails
   * even if their test suite passes.
   */
  test("the decrypting entry point is internal", async () => {
    const storageModule = await import("../functions/storage");
    const decryptingExport = storageModule.getBindingForGateway as unknown as {
      isPublic?: boolean;
      isInternal?: boolean;
      isAction?: boolean;
    };
    expect(decryptingExport.isInternal).toBe(true);
    expect(decryptingExport.isPublic).toBeFalsy();
    expect(decryptingExport.isAction).toBe(true);

    // ...and every *public* export in the module is a query or mutation with
    // no "secret" in its name.
    for (const [name, value] of Object.entries(storageModule)) {
      const fn = value as { isPublic?: boolean };
      if (fn?.isPublic) {
        expect(name.toLowerCase()).not.toContain("secret");
        expect(name.toLowerCase()).not.toContain("credential");
        expect(name.toLowerCase()).not.toContain("decrypt");
      }
    }
  });
});

describe("getBindingForGateway (internal)", () => {
  test("round-trips the credential the gateway needs", async () => {
    const { t, workspaceId } = await boundWorkspace();

    const credential = await t.action(
      internal.functions.storage.getBindingForGateway,
      { workspaceId },
    );

    expect(credential).toMatchObject({
      provider: FAKE_STORAGE.provider,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      secretAccessKey: FAKE_STORAGE.secretAccessKey,
    });
  });

  test("returns null for a workspace with no binding", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");

    expect(
      await t.action(internal.functions.storage.getBindingForGateway, {
        workspaceId,
      }),
    ).toBeNull();
  });
});

describe("recordVerification (internal)", () => {
  test("marks a binding connected and records probed capabilities", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();

    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: true },
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding).toMatchObject({
      status: "connected",
      capabilities: { conditionalWrite: true },
    });
    expect(binding?.lastVerifiedAt).toBeGreaterThan(0);
    expect(binding?.lastError).toBeUndefined();
  });

  test("records a failure without pretending the bucket works", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();

    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: false,
      error: "AccessDenied listing the bucket",
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.status).toBe("error");
    expect(binding?.lastError).toContain("AccessDenied");
  });

  test("a later success clears the stale error", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();

    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: false,
      error: "AccessDenied listing the bucket",
    });
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: false },
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.status).toBe("connected");
    expect(binding?.lastError).toBeUndefined();
  });
});

describe("disconnectStorage", () => {
  test("deletes the credential outright rather than flagging it", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();

    const result = await asUser(t, owner).mutation(
      api.functions.storage.disconnectStorage,
      { workspaceId },
    );
    expect(result.disconnected).toBe(true);

    const rows = await t.run((ctx) => ctx.db.query("storageBindings").collect());
    expect(rows).toHaveLength(0);

    // And the gateway can no longer get a credential for it.
    expect(
      await t.action(internal.functions.storage.getBindingForGateway, {
        workspaceId,
      }),
    ).toBeNull();
  });

  test("is idempotent", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
      workspaceId,
    });
    const second = await asUser(t, owner).mutation(
      api.functions.storage.disconnectStorage,
      { workspaceId },
    );
    expect(second.disconnected).toBe(false);
  });

  test("leaves an audit trail that carries no credential", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
      workspaceId,
    });

    const events = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("storage.disconnected");
    expect(actions).toContain("storage.bound");

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(serialized).not.toContain(FAKE_STORAGE.accessKeyId);
  });
});

describe("audit of storage changes names the acting identity", () => {
  test("a rebind by a second owner is attributed to that owner, not to a scope", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    const workspaceId = await createWorkspace(t, alice, "shared-context", {
      kind: "shared",
    });
    await addMember(t, workspaceId, bob, "owner", alice);

    await bindFakeStorage(t, alice, workspaceId);
    await bindFakeStorage(t, bob, workspaceId, { bucket: "bobs-choice" });

    const events = await asUser(t, alice).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    const rebind = events.find((e) => e.action === "storage.rebound");
    expect(rebind?.actorUserId).toBe(bob);
    expect(rebind?.actorEmail).toBe("bob@example.invalid");
  });
});
