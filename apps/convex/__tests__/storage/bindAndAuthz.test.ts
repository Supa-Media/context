import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import { decryptSecret } from "../../functions/lib/crypto";
import {
  FAKE_STORAGE,
  asUser,
  bindFakeStorage,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "../fixtures.helpers";
import {
  asS3,
  boundWorkspace,
} from "./fixtures.helpers";

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
    const storageModule = await import("../../functions/storage");
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
