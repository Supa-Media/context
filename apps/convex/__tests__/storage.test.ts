/**
 * Storage bindings.
 *
 * The two things that must hold no matter what changes here:
 *  - the secret access key is never stored in the clear, and
 *  - no public function returns it, in any form, to anyone.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  type TestConvex,
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

/**
 * Narrow a gateway credential to the S3 shape.
 *
 * The credential is a union now — a Dropbox binding carries an access token and
 * no key pair — so a test about a bucket secret has to say it is looking at a
 * bucket. Asserting rather than casting: if one of these fixtures ever became
 * a Dropbox binding, this fails instead of reading `undefined`.
 */
function asS3(credential: unknown) {
  const c = credential as { provider?: string; secretAccessKey?: string; forcePathStyle?: boolean };
  expect(c?.provider).not.toBe("dropbox");
  return c;
}

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
    // An S3 binding always carries this; the field is only optional because a
    // Dropbox binding has no bucket secret at all.
    expect(binding!.encryptedSecretAccessKey).toBeDefined();
    expect(binding!.encryptedSecretAccessKey).not.toContain(
      FAKE_STORAGE.secretAccessKey,
    );
    // `v2` — the envelope now carries a key id and is bound to the workspace.
    // See `lib/crypto.ts` for why `v1` is rejected rather than migrated.
    expect(binding!.encryptedSecretAccessKey!.startsWith("v2:")).toBe(true);
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

  /**
   * The endpoint is an SSRF sink.
   *
   * An owner types a URL and something of ours later makes a request to it —
   * the connect probe now, the gateway afterwards. "The owner chose it" is not
   * a defense, because the request is not made *as* the owner: it is made from
   * inside our network, with whatever that reaches. `169.254.169.254` is the
   * cloud instance-metadata service; the RFC 1918 ranges are whatever else is
   * on the box's network.
   */
  test("refuses an endpoint pointing back inside our own network", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");

    for (const endpoint of [
      "https://169.254.169.254/latest/meta-data/", // instance metadata
      "https://localhost:9000/",
      "https://127.0.0.1/",
      "https://10.0.0.5/",
      "https://192.168.1.10/",
      "https://172.16.4.2/",
      "https://[::1]/",
      "https://[fd00::1]/",
      "https://minio.internal/",
      "https://storage.local/",
    ]) {
      expect(
        errorCode(
          await captureError(() =>
            bindFakeStorage(t, owner, workspaceId, { endpoint }),
          ),
        ),
        `${endpoint} was accepted`,
      ).toBe("INVALID_ENDPOINT");
    }

    // Nothing was written by any of those attempts.
    expect(await t.run((ctx) => ctx.db.query("storageBindings").collect())).toEqual(
      [],
    );
  });

  test("still accepts an ordinary provider endpoint", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");

    for (const endpoint of [
      "https://accountid.r2.cloudflarestorage.example/",
      "https://s3.us-east-1.amazonaws.example/",
      "https://s3.example.com:9000/",
    ]) {
      const result = await bindFakeStorage(t, owner, workspaceId, { endpoint });
      expect(result.status).toBe("unverified");
    }
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
    expect(serialized).not.toContain("v2:");
    // Even the access key id — half a credential — comes back masked.
    expect(serialized).not.toContain(FAKE_STORAGE.accessKeyId);
    expect(binding?.maskedAccessKeyId?.endsWith("ID00")).toBe(true);
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

/**
 * An envelope is bound to the workspace it was written for.
 *
 * The reviewer's demonstration: copy Alice's `encryptedSecretAccessKey` into
 * Bob's binding row and ask the gateway for Bob's credential. It returned
 * Alice's plaintext. `getBindingForGateway` does no authorization of its own —
 * a bare `workspaceId` goes in and a decrypted secret comes out — so before
 * the AAD, the whole credential boundary was "whatever calls it passes the
 * right id", and the thing that calls it (the gateway) is not written yet.
 */
describe("a credential cannot be moved between workspaces", () => {
  test("Alice's envelope in Bob's row yields nothing, not Alice's secret", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    const aliceWs = await createWorkspace(t, alice, "alice-context");
    const bobWs = await createWorkspace(t, bob, "bob-context");

    await bindFakeStorage(t, alice, aliceWs, {
      secretAccessKey: "alice-secret-not-real-00000000000000",
    });
    await bindFakeStorage(t, bob, bobWs, {
      secretAccessKey: "bob-secret-not-real-0000000000000000",
    });

    // The attack: lift the opaque envelope out of Alice's row into Bob's.
    await t.run(async (ctx) => {
      const alices = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .unique();
      const bobs = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", bobWs))
        .unique();
      await ctx.db.patch(bobs!._id, {
        encryptedSecretAccessKey: alices!.encryptedSecretAccessKey,
      });
    });

    const error = await captureError(() =>
      t.action(internal.functions.storage.getBindingForGateway, {
        workspaceId: bobWs,
      }),
    );

    expect(errorCode(error)).toBe("CREDENTIAL_UNAVAILABLE");
    // Not merely "did not return the secret" — the secret is nowhere in the
    // failure either.
    expect(JSON.stringify((error as { data?: unknown }).data)).not.toContain(
      "alice-secret",
    );

    // Alice's own workspace is unaffected: this is a binding, not breakage.
    const alices = await t.action(
      internal.functions.storage.getBindingForGateway,
      { workspaceId: aliceWs },
    );
    expect(asS3(alices).secretAccessKey).toBe("alice-secret-not-real-00000000000000");
  });

  test("a v1 envelope is refused rather than opened unbound", async () => {
    const { t, workspaceId } = await boundWorkspace();

    // What a row written before the AAD existed looks like.
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(binding!._id, {
        encryptedSecretAccessKey: "v1:aXZpdml2aXZpdml2aQ==:Y2lwaGVydGV4dA==",
      });
    });

    const error = await captureError(() =>
      t.action(internal.functions.storage.getBindingForGateway, { workspaceId }),
    );
    // A coded `ConvexError`, not a bare `Error` the caller sees as
    // "Server Error" — the gateway has to be able to tell "rebind this" from
    // "we are broken".
    expect(errorCode(error)).toBe("CREDENTIAL_UNAVAILABLE");
  });
});

/**
 * Key rotation, end to end.
 *
 * `v1` recorded an algorithm version and no key id, so `decryptSecret` had
 * exactly one key to try. Rotating `STORAGE_SECRET_ENCRYPTION_KEY` made every
 * binding permanently undecryptable — the answer to "the key leaked" was "every
 * customer re-pastes their secret".
 */
describe("rotating the encryption key", () => {
  const SECOND_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";

  /** Swap the process env for one test, then put it back. */
  async function withEnv(
    overrides: Record<string, string | undefined>,
    body: () => Promise<void>,
  ) {
    const before: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(overrides)) {
      before[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await body();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  async function envelopeOf(
    t: TestConvex,
    workspaceId: Id<"workspaces">,
  ): Promise<string> {
    const binding = await t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    return binding!.encryptedSecretAccessKey!;
  }

  test("a binding written before a rotation keeps working, and can be moved to the new key", async () => {
    const { t, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    expect((await envelopeOf(t, workspaceId)).startsWith("v2:k1:")).toBe(true);

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        // Mid-rotation: the old envelope still opens.
        const credential = await t.action(
          internal.functions.storage.getBindingForGateway,
          { workspaceId },
        );
        expect(asS3(credential).secretAccessKey).toBe(FAKE_STORAGE.secretAccessKey);

        const result = await t.action(
          internal.functions.storage.rekeyStorageBindings,
          {},
        );
        expect(result).toMatchObject({ rekeyed: 1, skipped: 0, unreadable: 0 });
        expect((await envelopeOf(t, workspaceId)).startsWith("v2:k2:")).toBe(
          true,
        );

        // Idempotent: a second pass has nothing left to do.
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ rekeyed: 0 });
      },
    );

    // Rotation finished: the old key is gone from the environment entirely and
    // the binding still works. This is the step that was impossible before.
    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const credential = await t.action(
          internal.functions.storage.getBindingForGateway,
          { workspaceId },
        );
        expect(asS3(credential).secretAccessKey).toBe(FAKE_STORAGE.secretAccessKey);
      },
    );
  });

  test("the re-encryption keeps the workspace binding, so a rekeyed envelope is still not portable", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    const aliceWs = await createWorkspace(t, alice, "alice-context");
    const bobWs = await createWorkspace(t, bob, "bob-context");
    await bindFakeStorage(t, alice, aliceWs);
    await bindFakeStorage(t, bob, bobWs);
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ rekeyed: 2 });

        const alicesEnvelope = await envelopeOf(t, aliceWs);
        await t.run(async (ctx) => {
          const bobs = await ctx.db
            .query("storageBindings")
            .withIndex("by_workspace", (q) => q.eq("workspaceId", bobWs))
            .unique();
          await ctx.db.patch(bobs!._id, {
            encryptedSecretAccessKey: alicesEnvelope,
          });
        });

        expect(
          errorCode(
            await captureError(() =>
              t.action(internal.functions.storage.getBindingForGateway, {
                workspaceId: bobWs,
              }),
            ),
          ),
        ).toBe("CREDENTIAL_UNAVAILABLE");
      },
    );
  });

  test("a row nothing configured can open is counted and left alone, never destroyed", async () => {
    const { t, workspaceId } = await boundWorkspace();
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(binding!._id, {
        encryptedSecretAccessKey: "v1:aXZpdml2aXZpdml2aQ==:Y2lwaGVydGV4dA==",
      });
    });

    const result = await t.action(
      internal.functions.storage.rekeyStorageBindings,
      {},
    );
    expect(result).toMatchObject({ rekeyed: 0, unreadable: 1 });
    // Still there. A migration that deletes what it cannot read is a migration
    // that loses the customer's binding.
    expect(await envelopeOf(t, workspaceId)).toContain("v1:");
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

  /**
   * `lastError` is an untrusted string on a member-readable surface.
   *
   * The schema claimed it "never contains the secret" with nothing enforcing
   * it, and nothing bounded its length either — so whatever ran the probe
   * could store an arbitrarily large provider response, verbatim, for every
   * member of the workspace to read.
   */
  test("caps a huge provider error rather than storing it verbatim", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();

    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: false,
      error: "x".repeat(50_000),
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.lastError!.length).toBeLessThanOrEqual(300);
    expect(binding?.lastError!.endsWith("…")).toBe(true);
  });

  test("redacts the credential-shaped fragments it can recognize", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const envelope = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      return row!.encryptedSecretAccessKey;
    });

    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: false,
      error: `SignatureDoesNotMatch for ${FAKE_STORAGE.accessKeyId}: Credential=${FAKE_STORAGE.accessKeyId}/20260101/auto/s3, Signature=deadbeefcafe stored=${envelope}`,
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    const stored = binding?.lastError ?? "";

    expect(stored).not.toContain(FAKE_STORAGE.accessKeyId);
    expect(stored).not.toContain(envelope);
    expect(stored).not.toContain("deadbeefcafe");
    // ...and it is still a usable diagnostic, which is the point of keeping it.
    expect(stored).toContain("SignatureDoesNotMatch");
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

  test("a Dropbox disconnect also schedules the grant revocation", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    // Reshape the fixture's bucket binding into a Dropbox one. Direct db
    // writes, because what is under test is the disconnect, not the connect.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("storageBindings").unique();
      await ctx.db.patch(row!._id, {
        provider: "dropbox",
        encryptedRefreshToken: "v2:current:FAKE:ENVELOPE",
        endpoint: undefined,
        region: undefined,
        bucket: undefined,
        accessKeyId: undefined,
        encryptedSecretAccessKey: undefined,
      });
    });

    await asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
      workspaceId,
    });

    // The row is gone AND the revoke is on the schedule, carrying the
    // envelope it can no longer read from the row. Without the revoke, we
    // forget the credential while the grant lives on in the person's
    // Dropbox — and their next connect silently auto-approves the same
    // account, which is the "stuck in a cycle" Seyi hit live.
    const rows = await t.run((ctx) => ctx.db.query("storageBindings").collect());
    expect(rows).toHaveLength(0);
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const revokes = scheduled.filter((job) => job.name.includes("revokeDropboxGrant"));
    expect(revokes).toHaveLength(1);
    expect(JSON.stringify(revokes[0].args)).toContain("v2:current:FAKE:ENVELOPE");
  });

  test("a bucket disconnect schedules nothing — there is no grant to revoke", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
      workspaceId,
    });
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.filter((job) => job.name.includes("revokeDropboxGrant")),
    ).toHaveLength(0);
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
