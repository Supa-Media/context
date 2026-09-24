/**
 * Storage bindings.
 *
 * The two things that must hold no matter what changes here:
 *  - the secret access key is never stored in the clear, and
 *  - no public function returns it, in any form, to anyone.
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import {
  ROTATED_ENVELOPE_COLUMNS,
  ROTATION_EXEMPT_ENVELOPE_COLUMNS,
} from "../functions/storage";
import { decryptSecret, encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { managedBucketName } from "../functions/lib/managedStorage";
import { STORAGE_LAYOUT_PROBE_VERSION } from "../functions/lib/storageLayout";
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
  seedAppSecret,
  seedStorageBinding,
  setupTest,
  FAKE_D1,
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

    await bindFakeStorage(t, owner, workspaceId, { rootPrefix: "/notes/workspace/" });
    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.rootPrefix).toBe("notes/workspace/");

    expect(
      errorCode(
        await captureError(() =>
          bindFakeStorage(t, owner, workspaceId, { rootPrefix: "../escape" }),
        ),
      ),
    ).toBe("INVALID_ROOT_PREFIX");
  });

  /*
    The adapter's `describeKeyProblem` percent-decodes every segment before it
    compares, so `%2E%2E` is a ".." there and was a ".." at no door above it.
    A prefix this refuses is refused on the screen it was typed into; a prefix
    only the adapter refuses is a saved binding whose probe fails and whose
    every later request throws — the outcome `normalizeRootPrefix`'s own
    neighbours argue against, since a probe's job is to record a status rather
    than to explain a value.

    Equality per segment, not `includes`: the adapter compares whole segments,
    so `a%2E%2Eb` is a prefix it accepts and refusing it here would refuse a
    folder no layer objects to.
  */
  test("refuses a percent-encoded traversal in a root prefix, where the adapter does", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");

    for (const rootPrefix of ["%2E%2E/escape", "notes/%2e%2e/escape", "notes/%2E"]) {
      expect(
        errorCode(await captureError(() => bindFakeStorage(t, owner, workspaceId, { rootPrefix }))),
      ).toBe("INVALID_ROOT_PREFIX");
    }

    await bindFakeStorage(t, owner, workspaceId, { rootPrefix: "notes/a%2E%2Eb" });
    const binding = await asUser(t, owner).query(api.functions.storage.getStorageBinding, {
      workspaceId,
    });
    expect(binding?.rootPrefix).toBe("notes/a%2E%2Eb/");
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

  /**
   * The managed account is not somewhere a customer may bind.
   *
   * `refuseManagedEndpoint` is unit-tested in `managedStorage.test.ts`, and
   * that is not enough: with only those tests, deleting the call from
   * `assertUsableEndpoint` leaves the whole suite green, which is exactly the
   * shape `docs/decisions/testing.md` refuses. These drive the real action.
   *
   * The last two forms are the ones that matter. A guard matching the string
   * as typed accepted both — `new URL()` percent-decodes and IDNA-maps the
   * host, so the row would have been written pointing at the managed account
   * while the check read something else.
   */
  test("refuses an endpoint addressing the account that holds managed buckets", async () => {
    const managed = "0123456789abcdef0123456789abcdef";
    const previous = process.env.MANAGED_R2_ACCOUNT_ID;
    process.env.MANAGED_R2_ACCOUNT_ID = managed;
    try {
      const t = setupTest();
      const owner = await createUser(t, "owner@example.invalid");
      const workspaceId = await createWorkspace(t, owner, "atlas");

      for (const endpoint of [
        `https://${managed}.r2.cloudflarestorage.com`,
        `https://${managed}.eu.r2.cloudflarestorage.com/`,
        `https://a-bucket.${managed}.r2.cloudflarestorage.com`,
        "https://0123456789%61bcdef0123456789abcdef.r2.cloudflarestorage.com",
        "https://\uff10123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      ]) {
        expect(
          errorCode(
            await captureError(() =>
              bindFakeStorage(t, owner, workspaceId, { endpoint }),
            ),
          ),
          `${endpoint} was accepted`,
        ).toBe("MANAGED_ACCOUNT_NOT_ALLOWED");
      }

      // And nothing reached the table by any of those routes.
      expect(await t.run((ctx) => ctx.db.query("storageBindings").collect())).toEqual(
        [],
      );
    } finally {
      if (previous === undefined) delete process.env.MANAGED_R2_ACCOUNT_ID;
      else process.env.MANAGED_R2_ACCOUNT_ID = previous;
    }
  });

  /**
   * A self-hoster has no managed account, and their own storage must bind
   * exactly as it did before this guard existed.
   */
  test("refuses nothing when no managed account is configured", async () => {
    const previous = process.env.MANAGED_R2_ACCOUNT_ID;
    delete process.env.MANAGED_R2_ACCOUNT_ID;
    try {
      const t = setupTest();
      const owner = await createUser(t, "owner@example.invalid");
      const workspaceId = await createWorkspace(t, owner, "atlas");
      await bindFakeStorage(t, owner, workspaceId, {
        endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      });
      expect(
        (await t.run((ctx) => ctx.db.query("storageBindings").collect())).length,
      ).toBe(1);
    } finally {
      if (previous !== undefined) process.env.MANAGED_R2_ACCOUNT_ID = previous;
    }
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

  async function dataKeyEnvelopeOf(
    t: TestConvex,
    workspaceId: Id<"workspaces">,
  ): Promise<string> {
    const row = await t.run((ctx) =>
      ctx.db
        .query("workspaceDataKeys")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    return row!.encryptedDataKey;
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

  /**
   * THE ENVELOPE THAT IS NOT ON A BINDING.
   *
   * `workspaceDataKeys.encryptedDataKey` is sealed by the same scheme and
   * carries the same key id, and it is the one envelope in this control plane
   * whose loss cannot be repaired: it opens the encrypted notes in somebody's
   * bucket, and re-entering a credential does not bring it back.
   *
   * A pass that walked only `storageBindings` would report "nothing left" with
   * these rows still under the outgoing key, and step 4 of the operator
   * sequence — unset the PREVIOUS variables — would then destroy every
   * encrypted note in every context. So the assertion that matters is the last
   * one: the key still opens **after the old envelope key is gone from the
   * environment entirely**, which is the state a finished rotation leaves.
   */
  test("a workspace data key is moved forward too, and still opens once the old key is gone", async () => {
    const { t, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;

    const before = await t.action(
      internal.functions.encryptionKeys.openWorkspaceDataKey,
      { workspaceId, create: true },
    );
    const sealedBefore = await dataKeyEnvelopeOf(t, workspaceId);
    expect(sealedBefore.startsWith("v2:k1:")).toBe(true);

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        const result = await t.action(
          internal.functions.storage.rekeyStorageBindings,
          {},
        );
        expect(result).toMatchObject({
          rekeyed: 1,
          dataKeysRekeyed: 1,
          dataKeysSkipped: 0,
          dataKeysUnreadable: 0,
        });
        // The envelope moved; the material inside it did not. A rotation that
        // wrote a *new* key here would look identical from the outside and
        // would have made every note already encrypted unreadable.
        const sealedAfter = await dataKeyEnvelopeOf(t, workspaceId);
        expect(sealedAfter.startsWith("v2:k2:")).toBe(true);
        expect(sealedAfter).not.toBe(sealedBefore);

        // Idempotent, like the binding half.
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ rekeyed: 0, dataKeysRekeyed: 0 });
      },
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const after = await t.action(
          internal.functions.encryptionKeys.openWorkspaceDataKey,
          { workspaceId },
        );
        expect(after).toEqual(before);
      },
    );
  });

  /**
   * THE RETIRED GENERATION, WHICH IS THE ONE A PASS COULD MOST EASILY MISS.
   *
   * After a workspace-key rotation this table holds more than one row per
   * workspace, and the extra rows are the ones nothing is currently writing
   * with. A pass that moved only the *current* generation forward would report
   * "nothing left" with the retired rows still sealed under the outgoing
   * envelope key — and step 4 of the operator sequence, unsetting the PREVIOUS
   * variables, would then make every note still wrapped under that generation
   * permanently unreadable. Those notes are exactly the ones the grace period
   * in `docs/decisions/encryption.md` exists to protect: a restore from bucket
   * versioning, a client that synced the bucket directly, a walk that has not
   * reached them yet.
   *
   * `listDataKeyRekeyCandidates` walks the table rather than a workspace's
   * current row, so this passes — and it is asked here because nothing else
   * asks it, and because "one row per workspace" was true of this table until
   * rotation shipped.
   */
  test("a RETIRED generation is moved forward too, and still opens once the old key is gone", async () => {
    const { t, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;

    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });
    await t.action(internal.functions.encryptionKeys.startWorkspaceKeyRotation, {
      workspaceId,
    });
    const before = await t.action(
      internal.functions.encryptionKeys.openWorkspaceDataKey,
      { workspaceId },
    );
    expect(Object.keys(before!.keys).sort()).toEqual(["k1", "k2"]);

    const sealed = async () =>
      (
        await t.run((ctx) =>
          ctx.db
            .query("workspaceDataKeys")
            .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
            .collect(),
        )
      )
        .map((row) => row.encryptedDataKey)
        .sort();
    expect((await sealed()).every((envelope) => envelope.startsWith("v2:k1:"))).toBe(true);

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        // BOTH rows, not one: the retired generation is a candidate too.
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ dataKeysRekeyed: 2, dataKeysUnreadable: 0 });
        expect((await sealed()).every((envelope) => envelope.startsWith("v2:k2:"))).toBe(true);
      },
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        // Same material on both generations, with the old envelope key gone
        // from the environment entirely — which is the state a finished
        // rotation leaves, and the state a note on k1 has to survive.
        expect(
          await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
            workspaceId,
          }),
        ).toEqual(before);
      },
    );
  });

  test("a data key the pass cannot open is counted, never rewritten", async () => {
    const { t, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceDataKeys")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, {
        encryptedDataKey: "v1:aXZpdml2aXZpdml2aQ==:Y2lwaGVydGV4dA==",
      });
    });

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
        ).toMatchObject({ dataKeysRekeyed: 0, dataKeysUnreadable: 1 });
        // Left exactly as it was. Generating a replacement here would be data
        // loss wearing the costume of a repair.
        expect(await dataKeyEnvelopeOf(t, workspaceId)).toContain("v1:");
      },
    );
  });

  /**
   * THE EXACT MISS `encryptedDataKey` WAS, ARRIVING A SECOND TIME.
   *
   * `googleConnections` is its own table, so `listRekeyCandidates` above
   * never sees a Google refresh or access token no matter how completely
   * `ENVELOPE_FIELDS` is enumerated — that list is queried against
   * `storageBindings` rows only. Column-name accounting
   * (`ROTATED_ENVELOPE_COLUMNS`, checked by the guard below) cannot catch a
   * table the walk itself never visits; only this test, actually running
   * `rekeyStorageBindings` against a `googleConnections` row, can. The token
   * stays top-level on the generalized row (never nested under `gmail`),
   * which is what keeps this test — and the rotation code it proves — from
   * needing to change shape if Calendar or Chat land on the same row.
   */
  test("a connected Google account's tokens are moved forward too", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    const context = { workspaceId: workspaceId as string };
    const now = Date.now();
    const refreshBefore = await encryptSecret("google-refresh-abc", requireKeyset(), context);
    const accessBefore = await encryptSecret("google-access-xyz", requireKeyset(), context);
    expect(refreshBefore.startsWith("v2:k1:")).toBe(true);

    const connectionId = await t.run((ctx) =>
      ctx.db.insert("googleConnections", {
        workspaceId,
        provider: "google" as const,
        address: "person@example.invalid",
        encryptedRefreshToken: refreshBefore,
        encryptedAccessToken: accessBefore,
        accessTokenExpiresAt: now + 3_600_000,
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        googleAccountId: "google-account-1",
        products: ["gmail"] as const,
        gmail: {
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          mailboxSlug: "person-at-example-invalid",
          backfillDays: 90,
          folders: ["inbox", "sent"] as const,
          storeRawMime: false,
          attachmentMode: "store" as const,
          attachmentRetentionDays: 90,
          quotaBytes: 5 * 1024 * 1024 * 1024,
        },
        health: "active" as const,
        boundBy: owner,
        createdAt: now,
        updatedAt: now,
      }),
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        const result = await t.action(internal.functions.storage.rekeyStorageBindings, {});
        expect(result).toMatchObject({
          googleConnectionsRekeyed: 2, // refresh AND access token
          googleConnectionsSkipped: 0,
          googleConnectionsUnreadable: 0,
        });

        const row = await t.run((ctx) => ctx.db.get(connectionId));
        expect(row!.encryptedRefreshToken.startsWith("v2:k2:")).toBe(true);
        expect(row!.encryptedAccessToken!.startsWith("v2:k2:")).toBe(true);
        expect(row!.encryptedRefreshToken).not.toBe(refreshBefore);

        // Idempotent, like every other half of this pass.
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ googleConnectionsRekeyed: 0 });
      },
    );

    // Still opens once the old key is gone from the environment entirely —
    // the state a finished rotation leaves, and the property that matters.
    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const row = await t.run((ctx) => ctx.db.get(connectionId));
        expect(await decryptSecret(row!.encryptedRefreshToken, requireKeyset(), context)).toBe(
          "google-refresh-abc",
        );
      },
    );
  });

  /**
   * THE SAME MISS, ASKED OF A ROW WITH NO `gmail` OBJECT ON IT AT ALL.
   *
   * The test above proves the walk visits `googleConnections`, but it seeds a
   * Gmail row — so it would still pass if the walk (or a future "only rows we
   * actually sync" optimisation of it) filtered on `products`, on the presence
   * of `gmail`, or on a mailbox slug. A Chat-only connection is the row shape
   * that has none of those, and it holds exactly the same refresh token: the
   * token is top-level on the shared row precisely so rotation never has to
   * know which products are enabled, and this is the test that says so.
   *
   * Sabotage: add `.filter((q) => q.neq(q.field("gmail"), undefined))` to
   * `listGoogleConnectionRekeyCandidates` — the Gmail test above stays green
   * and this one fails, with the chat row's token stranded on the old key.
   */
  test("a Chat-only connection's token is moved forward too", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    const context = { workspaceId: workspaceId as string };
    const now = Date.now();
    const refreshBefore = await encryptSecret("google-chat-refresh-abc", requireKeyset(), context);
    expect(refreshBefore.startsWith("v2:k1:")).toBe(true);

    const connectionId = await t.run((ctx) =>
      ctx.db.insert("googleConnections", {
        workspaceId,
        provider: "google" as const,
        address: "person@example.invalid",
        encryptedRefreshToken: refreshBefore,
        accessTokenExpiresAt: now + 3_600_000,
        scopes: [
          "https://www.googleapis.com/auth/chat.messages.readonly",
          "https://www.googleapis.com/auth/chat.spaces.readonly",
        ],
        googleAccountId: "google-account-1",
        products: ["chat"] as const,
        chat: {
          scopes: [
            "https://www.googleapis.com/auth/chat.messages.readonly",
            "https://www.googleapis.com/auth/chat.spaces.readonly",
          ],
          nonceSeed: "not-a-credential-just-a-seed",
        },
        health: "active" as const,
        boundBy: owner,
        createdAt: now,
        updatedAt: now,
      }),
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        expect(await t.action(internal.functions.storage.rekeyStorageBindings, {})).toMatchObject({
          googleConnectionsRekeyed: 1, // refresh only — a chat row caches no access token yet
          googleConnectionsSkipped: 0,
          googleConnectionsUnreadable: 0,
        });
        expect((await t.run((ctx) => ctx.db.get(connectionId)))!.encryptedRefreshToken.startsWith("v2:k2:")).toBe(
          true,
        );
      },
    );

    // And it still opens once the old key is gone from the environment
    // entirely — the state a finished rotation leaves, which is the whole
    // point of the walk having visited this row.
    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const row = await t.run((ctx) => ctx.db.get(connectionId));
        expect(await decryptSecret(row!.encryptedRefreshToken, requireKeyset(), context)).toBe(
          "google-chat-refresh-abc",
        );
        // The chat product's own state rode along untouched — rotation moves
        // the envelope and nothing else.
        expect(row!.chat?.nonceSeed).toBe("not-a-credential-just-a-seed");
      },
    );
  });

  /**
   * AND THE THIRD ROW SHAPE, THE ONE A **CALENDAR** CONNECT ACTUALLY WRITES.
   *
   * Added by the adversarial review of the Calendar PR, for the reason the
   * Chat test above gives and one more: this row is written by
   * `applyCalendarConnectionBinding` itself rather than inserted by hand, so
   * it also proves the mutation this product ships puts the token pair where
   * the walk looks — top-level on the shared row — rather than somewhere a
   * clean-looking rotation pass would report success without visiting.
   *
   * Sabotage, measured: adding `if (row.products.includes("calendar")) continue;`
   * to `listGoogleConnectionRekeyCandidates` — the shape of any "skip the
   * rows this pass does not own" refactor — fails exactly this test, on the
   * rekeyed count, and leaves every other test in this file green, both the
   * Gmail and Chat rotation proofs above included.
   */
  test("a Calendar-only connection's token rotates too — the token is the account's, not the product's", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    const context = { workspaceId: workspaceId as string };

    await t.mutation(internal.functions.calendarConnect.applyCalendarConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address: "person@example.invalid",
      googleAccountId: "google-account-cal",
      scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      encryptedRefreshToken: await encryptSecret("calendar-refresh-abc", requireKeyset(), context),
      encryptedAccessToken: await encryptSecret("calendar-access-xyz", requireKeyset(), context),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });

    const before = await t.run((ctx) => ctx.db.query("googleConnections").unique());
    expect(before!.gmail).toBeUndefined();
    expect(before!.chat).toBeUndefined();
    expect(before!.products).toEqual(["calendar"]);
    expect(before!.encryptedRefreshToken.startsWith("v2:k1:")).toBe(true);

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        expect(await t.action(internal.functions.storage.rekeyStorageBindings, {})).toMatchObject({
          googleConnectionsRekeyed: 2, // refresh AND the cached access token
          googleConnectionsSkipped: 0,
          googleConnectionsUnreadable: 0,
        });
        const row = await t.run((ctx) => ctx.db.query("googleConnections").unique());
        expect(row!.encryptedRefreshToken.startsWith("v2:k2:")).toBe(true);
        expect(row!.encryptedAccessToken!.startsWith("v2:k2:")).toBe(true);
      },
    );

    // The old key gone from the environment entirely — the state a finished
    // rotation leaves — and the calendar connection still opens.
    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const row = await t.run((ctx) => ctx.db.query("googleConnections").unique());
        expect(await decryptSecret(row!.encryptedRefreshToken, requireKeyset(), context)).toBe(
          "calendar-refresh-abc",
        );
        expect(await decryptSecret(row!.encryptedAccessToken!, requireKeyset(), context)).toBe(
          "calendar-access-xyz",
        );
        // The calendar product's own cursor state rode along untouched.
        expect(row!.calendar?.scopes).toEqual(["https://www.googleapis.com/auth/calendar.events.readonly"]);
      },
    );
  });

  /**
   * A disconnected connection's refresh token is the empty string
   * (`disconnectGoogleConnection` clears it, never deletes the row), and
   * empty is never a rekey candidate — there is nothing there to re-seal, and
   * `envelopeKeyId("")` would only ever be `unreadable` noise on every future
   * pass for a credential that is intentionally gone.
   */
  test("a disconnected connection's empty token is not a rekey candidate", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("googleConnections", {
        workspaceId,
        provider: "google" as const,
        address: "gone@example.invalid",
        encryptedRefreshToken: "",
        scopes: [],
        googleAccountId: "google-account-2",
        products: ["gmail"] as const,
        gmail: {
          scopes: [],
          mailboxSlug: "gone-at-example-invalid",
          backfillDays: 90,
          folders: ["inbox", "sent"] as const,
          storeRawMime: false,
          attachmentMode: "store" as const,
          attachmentRetentionDays: 90,
          quotaBytes: 5 * 1024 * 1024 * 1024,
        },
        health: "error" as const,
        disconnectedAt: now,
        boundBy: owner,
        createdAt: now,
        updatedAt: now,
      }),
    );

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
        ).toMatchObject({ googleConnectionsRekeyed: 0, googleConnectionsUnreadable: 0 });
      },
    );
  });

  /**
   * THE PLATFORM'S OWN CREDENTIALS, found by the guard below and fixed here.
   *
   * `appSecrets` is bound to the `integration` scope rather than to a
   * workspace, so it was in neither the pass nor anybody's list. Losing these
   * is an outage rather than data loss — an operator re-enters them — but a
   * rotation that cannot be finished without breaking search provisioning and
   * mail is a rotation nobody performs, which is the state this pass exists to
   * end.
   */
  test("a platform secret is moved forward too, and its fingerprint does not move with it", async () => {
    const { t } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    await seedAppSecret(t, "SEARCH_D1_API_TOKEN", FAKE_D1.apiToken);
    const fingerprintBefore = await t.run(async (ctx) => {
      const row = await ctx.db.query("appSecrets").unique();
      return row!.fingerprint;
    });

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
        ).toMatchObject({
          platformSecretsRekeyed: 1,
          platformSecretsSkipped: 0,
          platformSecretsUnreadable: 0,
        });
      },
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const row = await t.run(async (ctx) => await ctx.db.query("appSecrets").unique());
        expect(row!.encryptedValue.startsWith("v2:k2:")).toBe(true);
        // Derived from the plaintext, which a rotation does not touch. A
        // fingerprint that moved would tell an operator their credential had
        // been replaced.
        expect(row!.fingerprint).toBe(fingerprintBefore);
        expect(
          await t.action(internal.functions.admin.readIntegrationSecret, {
            name: "SEARCH_D1_API_TOKEN",
          }),
        ).toBe(FAKE_D1.apiToken);
      },
    );
  });

  /**
   * The guard that would have caught the miss above.
   *
   * `dropboxBinding.test.ts` already couples `ENVELOPE_FIELDS` to the schema —
   * but it reads only the `storageBindings` slice of it, so an encrypted column
   * in a **new table** was invisible to it. That is the same blindness its own
   * rationale warns about one level down, and `encryptedDataKey` walked
   * straight through it.
   */
  test("every encrypted column in the whole schema is one rotation moves", () => {
    const schema = ["../schema.ts", ...readdirSync(new URL("../functions/lib/schema/", import.meta.url)).sort().map((name) => `../functions/lib/schema/${name}`)].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
    const declared = [
      ...new Set(
        [...schema.matchAll(/^\s+(encrypted[A-Za-z0-9]*)\s*:\s*v\./gm)].map(
          (match) => match[1]!,
        ),
      ),
    ];
    expect(declared.length).toBeGreaterThan(3);
    // Two lists, and every encrypted column must be in exactly one of them. A
    // column in neither is not "probably fine": it is an envelope whose fate on
    // the operator's step 4 nobody has decided, which is how `encryptedDataKey`
    // — the one envelope in this control plane that cannot be re-entered —
    // came to be missing from the pass.
    const accounted = [
      ...(ROTATED_ENVELOPE_COLUMNS as readonly string[]),
      ...(ROTATION_EXEMPT_ENVELOPE_COLUMNS as readonly string[]),
    ];
    for (const column of declared) {
      expect(
        accounted,
        `schema column "${column}" is encrypted at rest but is in neither ROTATED_ENVELOPE_COLUMNS nor ROTATION_EXEMPT_ENVELOPE_COLUMNS, so nobody has decided what retiring the previous key does to it`,
      ).toContain(column);
    }
    // And the exemptions are exemptions, not a second copy of the pass.
    for (const column of ROTATION_EXEMPT_ENVELOPE_COLUMNS as readonly string[]) {
      expect(ROTATED_ENVELOPE_COLUMNS as readonly string[]).not.toContain(column);
    }
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
  test("refuses to strand a managed bucket behind an active plan", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.run(async (ctx) => {
      const binding = await ctx.db.query("storageBindings").unique();
      await ctx.db.patch(binding!._id, { bucket: managedBucketName(workspaceId) });
      await ctx.db.insert("workspacePlans", {
        workspaceId,
        managedStorage: true,
        fastSearch: false,
        status: "active",
        managedProvisioning: "ready",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await expect(
      asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
        workspaceId,
      }),
    ).rejects.toThrow(/managed storage/i);
    expect(await t.run((ctx) => ctx.db.query("storageBindings").unique())).not.toBeNull();
  });
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

describe("where the storage-layout migration got to", () => {
  /*
    The migration has always written its own state into the bucket, under
    `.context/`, and short-circuits on `complete`. Nothing outside the bucket
    could read it, so the console had no way to tell "this bucket still needs
    the update" from "it ran last week" — and answered the offer with a flag on
    one device, which is why the notice came back on every other one.

    This is the copy that travels with the workspace. Same category as
    `noteCount`: something we observed while holding a credential, which no
    query can recompute without becoming a public function that opens one.
  */
  test("a fresh binding has none, which is what still offers the migration", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.storageLayoutState).toBeUndefined();
    expect(binding?.storageLayoutAt).toBeUndefined();
    // And nobody has *asked* it, which is the half that decides the offer.
    expect(binding?.storageLayoutCheckedAt).toBeUndefined();
  });

  /*
    THE ABSENCE THAT MEANT TWO THINGS.

    Recording the outcome fixed the offer for every context migrated after the
    column existed, and for nobody else. A context migrated before it kept
    `complete` in its own bucket and nothing in this row — and an empty column
    read as "nobody has run this", so the notice came back on every device, for
    ever, for exactly the people who had already run it.

    So the question and the answer are recorded separately. `checkedAt` says
    the bucket was asked; the state stays what it said.
  */
  test("a bucket that answers 'never run' is a different fact from one nobody asked", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    // Nothing has run here, and that is now a recorded answer rather than an
    // unasked question.
    expect(binding?.storageLayoutState).toBeUndefined();
    expect(binding?.storageLayoutCheckedAt).toBeGreaterThan(0);
    // No outcome was observed, so nothing claims one was.
    expect(binding?.storageLayoutAt).toBeUndefined();
  });

  test("recording an outcome also records that the bucket was asked", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.storageLayoutState).toBe("complete");
    expect(binding?.storageLayoutCheckedAt).toBeGreaterThan(0);
  });

  test("a state file that has gone stops claiming the bucket is migrated", async () => {
    /*
      The bucket is authoritative and this row is a copy of it. A copy that
      outlives what it copied is the stale-green-check failure the rebind clear
      exists to avoid, so an observation of "no state here" clears a state we
      had rather than keeping the more flattering answer.
    */
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.storageLayoutState).toBeUndefined();
    expect(binding?.storageLayoutCheckedAt).toBeGreaterThan(0);
  });

  /**
   * The probe budget belongs to the context, not to the deployment.
   *
   * `OBSERVE_LAYOUT_LIMIT` is the ceiling on probes against a bucket that will
   * not answer — low on purpose, because nobody is waiting on the result. Four
   * is also low enough that a shared counter is spent by accident: one context
   * whose bucket is unreachable, with a console mounting on a phone and a
   * laptop, reaches it inside a minute. Keyed globally, every other customer's
   * layout notice then stays up forever, because the question that would clear
   * it can no longer be asked.
   *
   * Nothing here could see that. The guard spends itself after one success, so
   * every existing test calls this once or twice against a single workspace and
   * the limit never engages at all — which is why the whole suite passed with
   * `${args.workspaceId}` removed from the key. Exhausting it is the only way
   * to look at the key at all.
   *
   * ## Two wrong keys, and why it takes two neighbours to rule out both
   *
   * `:all` and `:${userId}` are different mistakes and a second context does
   * not catch both. A budget keyed by the caller is refuted only by the same
   * person's *other* context — two owners would sail through it, because their
   * ids differ anyway. A budget keyed globally is refuted by either. So the
   * owner's second workspace is the instrument, and the neighbour is the claim
   * being made: one customer's unreachable bucket must not be able to silence
   * another customer's layout notice.
   *
   * Sabotage, as failing tests across the whole `apps/convex` suite:
   *
   *   `storage.observeLayout:all`                                    0 -> 1
   *   `storage.observeLayout:${userId}`                              0 -> 1
   *   the `consumeRateLimit` call deleted outright                        1
   */
  test("a second context has its own probe budget, spent by nobody", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: true },
    });

    // The same owner's other context, and a different customer's.
    const mine = await createWorkspace(t, owner, "bravo");
    const neighbour = await createUser(t, "neighbour@example.invalid");
    const theirs = await createWorkspace(t, neighbour, "charlie");
    for (const [id, who] of [
      [mine, owner],
      [theirs, neighbour],
    ] as const) {
      await seedStorageBinding(t, {
        workspaceId: id,
        boundBy: who,
        status: "connected",
        bucket: `${id}-bucket`,
      });
    }

    /*
      The answer is only recorded by the scheduled read, which is never drained
      here — so the binding stays unanswered and every call is a fresh probe.
      That is the production shape this limit is for: a bucket that never
      answers, asked again by a console that mounted again.
    */
    const answers: unknown[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        answers.push(
          await asUser(t, owner).mutation(
            api.functions.storage.observeStorageLayout,
            { workspaceId },
          ),
        );
      } catch {
        break;
      }
    }
    // Asserted outside the loop: a failed expectation inside it would be caught
    // by the `catch` and read as the refusal, which is the one thing this is
    // trying to observe.
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.length).toBeLessThan(20);
    expect(answers.every((answer) => JSON.stringify(answer) === '{"queued":true}')).toBe(
      true,
    );
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, owner).mutation(api.functions.storage.observeStorageLayout, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("RATE_LIMITED");

    // Neither of the other two buckets has been asked anything, so both are.
    // The first rules out a budget keyed by the caller; the second is the
    // cross-tenant claim.
    expect(
      await asUser(t, owner).mutation(api.functions.storage.observeStorageLayout, {
        workspaceId: mine,
      }),
    ).toEqual({ queued: true });
    expect(
      await asUser(t, neighbour).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId: theirs },
      ),
    ).toEqual({ queued: true });
  });

  test("asking is owner-only, and spends itself once the bucket has answered", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    // Only a bucket we believe works is worth a question: an unverified or
    // errored binding is one the console is already shouting about, and a
    // probe against it fails for that reason rather than teaching anybody
    // anything.
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: true },
    });
    const member = await createUser(t, "asker@example.invalid");
    await addMember(t, workspaceId, member, "member");

    await expect(
      asUser(t, member).mutation(api.functions.storage.observeStorageLayout, {
        workspaceId,
      }),
    ).rejects.toThrow();

    // An unanswered binding is worth asking about exactly once...
    expect(
      await asUser(t, owner).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId },
      ),
    ).toEqual({ queued: true });

    // ...and once it has answered — by an observation or by a migration pass —
    // the question is spent, so a console that mounts again asks nothing.
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
    });
    expect(
      await asUser(t, owner).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId },
      ),
    ).toEqual({ queued: false });
  });

  test("a recorded outcome is readable, and stamped", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.storageLayoutState).toBe("complete");
    expect(binding?.storageLayoutAt).toBeGreaterThan(0);
  });

  test("a later pass overwrites an earlier one", async () => {
    // The chain records on every pass — `copying` while it walks, then the
    // terminal state — so the last write is the current answer rather than the
    // first one to land.
    const { t, owner, workspaceId } = await boundWorkspace();
    for (const state of ["copying", "copied", "complete"] as const) {
      await t.mutation(internal.functions.storage.recordStorageLayoutState, {
        workspaceId,
        state,
      });
    }
    expect(
      (
        await asUser(t, owner).query(api.functions.storage.getStorageBinding, {
          workspaceId,
        })
      )?.storageLayoutState,
    ).toBe("complete");
  });

  test("it is not clamped to the owner, unlike the note count", async () => {
    /*
      Deliberate, and the reason is the difference between the two: the count
      is a number about private notes, and this names no key and counts nothing
      of the customer's. Every member already sees the provider, the bucket and
      the verification status, and this says less than any of them.
    */
    const { t, owner, workspaceId } = await boundWorkspace();
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "member");
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });
    await t.mutation(internal.functions.storage.recordNoteCount, {
      workspaceId,
      notes: 42,
      truncated: false,
    });

    const seen = await asUser(t, member).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(seen?.storageLayoutState).toBe("complete");
    // The clamp beside it still holds, so this is not a test that stopped
    // checking anything.
    expect(seen?.noteCount).toBeUndefined();
  });

  test("rebinding clears it, so a different bucket is offered the migration", async () => {
    /*
      The failure this exists for is silent. A `complete` carried onto a bucket
      that has never been migrated is a bucket the console never offers it to:
      the pre-v1 plumbing stays where it is, dual reads keep carrying it, and
      no screen ever says so. Same argument as `lastVerifiedAt` and the note
      count above, and a worse outcome than either.
    */
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });

    await bindFakeStorage(t, owner, workspaceId, { bucket: "somewhere-else" });

    const rebound = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(rebound?.bucket).toBe("somewhere-else");
    expect(rebound?.storageLayoutState).toBeUndefined();
    expect(rebound?.storageLayoutAt).toBeUndefined();
    /*
      Including the record that it was ever asked. Left behind, a new bucket
      reads as "checked, and never migrated" — an answer nobody obtained about
      a bucket nobody looked at — and the console never offers it the update.
    */
    expect(rebound?.storageLayoutCheckedAt).toBeUndefined();
    expect(rebound?.storageLayoutCheckedVersion).toBeUndefined();
  });

  /*
    THE ANSWER THAT WAS ONLY AS GOOD AS THE QUESTION.

    The first probe asked one thing: is there a migration state file? A bucket
    **we scaffolded ourselves** has none — it was born on the v1 layout and has
    never in its life held a `.audit/` or a `.history/` — so it answered
    "nobody has run the migration here", which is true and beside the point:
    there has never been anything to migrate. Every newly created workspace was
    therefore offered a one-time storage update on its first console load, and
    dismissing it was the only thing that ended it.

    `readStorageLayoutState` now asks whether any pre-v1 plumbing is in the
    bucket at all and answers `complete` when none is. That fixes every bucket
    asked from now on and none of the rows the old question already wrote —
    which are exactly the new workspaces the bug was about, because a binding
    that has been asked is never asked again. So the generation is recorded
    with the answer, and a stale one is asked once more.
  */
  test("an answer from an older probe is asked again; the current one is not", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: true },
    });
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
    });

    // The answer the current probe gave is spent, exactly as before.
    expect(
      await asUser(t, owner).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId },
      ),
    ).toEqual({ queued: false });

    // A row written by the probe that got new workspaces wrong: asked, with
    // nothing recorded, and no generation beside it.
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(binding!._id, {
        storageLayoutCheckedVersion: undefined,
      });
    });

    expect(
      await asUser(t, owner).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId },
      ),
    ).toEqual({ queued: true });
  });

  test("a recorded state is the bucket's own word, and is never re-asked", async () => {
    /*
      Only the *absence* of a state can be wrong about a bucket: every
      generation of the probe reads a state file the same way, and a migration
      pass writes what it actually did. Re-asking there would spend somebody's
      request budget to be told what we already know — and, on a bucket
      mid-migration, would do it on every console mount.
    */
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: true },
    });
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "copying",
    });
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(binding!._id, {
        storageLayoutCheckedVersion: undefined,
      });
    });

    expect(
      await asUser(t, owner).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId },
      ),
    ).toEqual({ queued: false });
  });

  test("recording an answer stamps the generation that produced it", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
    });
    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    // The console reads this to tell an answer it can trust from one the probe
    // before it got wrong, so it has to survive the query boundary.
    expect(binding?.storageLayoutCheckedVersion).toBe(
      STORAGE_LAYOUT_PROBE_VERSION,
    );
  });

  test("a binding that went away drops the write rather than resurrecting a row", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.delete(binding!._id);
    });

    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });

    expect(
      await asUser(t, owner).query(api.functions.storage.getStorageBinding, {
        workspaceId,
      }),
    ).toBeNull();
  });
});
