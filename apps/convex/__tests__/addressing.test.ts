/**
 * Bucket addressing style — the field that decides which bucket a signed
 * request actually reaches.
 *
 * `S3Store` addresses a bucket by path (`https://endpoint/my-context/note.md`)
 * unless told otherwise, and **refuses to guess** when the endpoint's first
 * host label is the bucket name, because that shape is produced both by a
 * virtual-hosted endpoint and by a path-style one that collides by coincidence.
 * Guessing wrong is a silent write into somebody else's bucket, so the adapter
 * throws.
 *
 * That was correct and unusable: the control plane had nowhere to record an
 * answer, so `https://my-context.s3.amazonaws.com` was a permanent
 * `StorageUnavailable` with no way to fix it. What is proved here:
 *
 *  1. the ambiguity check in the control plane means **exactly** what the
 *     adapter's does, pinned against the real constructor rather than restated;
 *  2. the ambiguous case is refused at bind time, with an error naming both
 *     answers — not at probe time, where the owner cannot act on it;
 *  3. a virtual-hosted endpoint with `forcePathStyle: false` genuinely
 *     connects, against a backend that would 404 a path-style request;
 *  4. the stored answer reaches the gateway, so the store that signs a request
 *     addresses the bucket the same way the store that probed it did;
 *  5. absent stays absent — an ordinary R2 binding gains no field, and the
 *     adapter's own default keeps deciding.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { S3Store } from "../../mcp/src/store/s3.js";
import { hashToken } from "../functions/lib/crypto";
import { addressingIsAmbiguous } from "../functions/storage";
import {
  FAKE_STORAGE,
  asUser,
  bindFakeStorage,
  captureError,
  createUser,
  createWorkspace,
  drainScheduled,
  errorCode,
  gatewayPost,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";
import { memoryS3 } from "./storeStub.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A virtual-hosted endpoint: the bucket is already the first host label. */
const VIRTUAL_BUCKET = "my-context";
const VIRTUAL_ENDPOINT = `https://${VIRTUAL_BUCKET}.s3.example.invalid/`;

async function ownerAndWorkspace() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  return { t, owner, workspaceId };
}

/* -------------------------------------------------------------------------- */

describe("the ambiguity check means what the adapter means", () => {
  /**
   * The rule is stated twice — once in `S3Store`, once in `storage.ts` — so
   * that the refusal can happen at bind time instead of probe time. Two copies
   * of a rule drift, and a drift here is either a bind that fails for no reason
   * or a bind that succeeds and can never connect. So the copy is not asserted
   * against a restatement of the rule; it is asserted against the constructor.
   */
  test("it is true exactly when constructing the adapter without an answer throws", () => {
    const cases: { endpoint: string; bucket: string }[] = [
      // Ordinary path-style: R2, and the classic AWS regional endpoints.
      { endpoint: "https://accountid.r2.cloudflarestorage.example/", bucket: "my-context" },
      { endpoint: "https://s3.us-east-1.amazonaws.example/", bucket: "my-context" },
      // Genuinely virtual-hosted.
      { endpoint: "https://my-context.s3.amazonaws.example/", bucket: "my-context" },
      { endpoint: "https://my-context.s3.example.invalid/", bucket: "my-context" },
      // Path-style endpoints that collide by coincidence — the reason the
      // adapter refuses to guess rather than sniffing the host.
      { endpoint: "https://s3.wasabisys.example/", bucket: "s3" },
      { endpoint: "https://accountid.r2.cloudflarestorage.example/", bucket: "accountid" },
      // Near misses that must NOT be ambiguous: the label must match in full.
      { endpoint: "https://my-context-two.s3.example.invalid/", bucket: "my-context" },
      { endpoint: "https://notmy-context.s3.example.invalid/", bucket: "my-context" },
      { endpoint: "https://s3.example.invalid/my-context", bucket: "my-context" },
    ];

    for (const { endpoint, bucket } of cases) {
      let adapterThrew = false;
      try {
        new S3Store({
          endpoint,
          region: "auto",
          bucket,
          accessKeyId: FAKE_STORAGE.accessKeyId,
          secretAccessKey: FAKE_STORAGE.secretAccessKey,
        });
      } catch {
        adapterThrew = true;
      }
      expect(
        addressingIsAmbiguous(endpoint, bucket),
        `${endpoint} + ${bucket}: the control plane and the adapter disagree`,
      ).toBe(adapterThrew);
    }
  });

  /** Non-vacuity: the matrix above must contain both answers. */
  test("the matrix exercises both outcomes", () => {
    expect(addressingIsAmbiguous(VIRTUAL_ENDPOINT, VIRTUAL_BUCKET)).toBe(true);
    expect(addressingIsAmbiguous(FAKE_STORAGE.endpoint, FAKE_STORAGE.bucket)).toBe(
      false,
    );
  });

  /**
   * An explicit answer settles it either way. This is the property that makes
   * the whole feature work: the adapter only refuses when nothing told it.
   */
  test("an explicit answer stops the adapter refusing", () => {
    for (const forcePathStyle of [true, false]) {
      expect(
        () =>
          new S3Store({
            endpoint: VIRTUAL_ENDPOINT,
            region: "auto",
            bucket: VIRTUAL_BUCKET,
            accessKeyId: FAKE_STORAGE.accessKeyId,
            secretAccessKey: FAKE_STORAGE.secretAccessKey,
            forcePathStyle,
          }),
      ).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("bindStorage refuses the ambiguous case where it can be answered", () => {
  test("an ambiguous endpoint with no answer is refused, and names both options", async () => {
    const { t, owner, workspaceId } = await ownerAndWorkspace();

    const error = await captureError(() =>
      bindFakeStorage(t, owner, workspaceId, {
        endpoint: VIRTUAL_ENDPOINT,
        bucket: VIRTUAL_BUCKET,
      }),
    );
    expect(errorCode(error)).toBe("AMBIGUOUS_ADDRESSING");

    const message = (error as { data: { message: string } }).data.message;
    // Actionable means it says what to do, not that something went wrong.
    expect(message).toContain("forcePathStyle");
    expect(message).toContain("false");
    expect(message).toContain("true");
    expect(message).toContain(VIRTUAL_BUCKET);
    // …and it is still an error message about configuration, not a credential.
    expect(message).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(message).not.toContain(FAKE_STORAGE.accessKeyId);

    // Nothing was written. A half-bound row would leave the workspace claiming
    // storage it cannot use.
    expect(
      await t.run((ctx) => ctx.db.query("storageBindings").collect()),
    ).toEqual([]);
  });

  test("the same endpoint binds fine once the question is answered", async () => {
    for (const forcePathStyle of [true, false]) {
      const { t, owner, workspaceId } = await ownerAndWorkspace();
      await bindFakeStorage(t, owner, workspaceId, {
        endpoint: VIRTUAL_ENDPOINT,
        bucket: VIRTUAL_BUCKET,
        forcePathStyle,
      });

      const stored = await t.run((ctx) =>
        ctx.db.query("storageBindings").unique(),
      );
      expect(stored?.forcePathStyle).toBe(forcePathStyle);
    }
  });

  test("an ordinary endpoint stores no answer at all, so the adapter keeps deciding", async () => {
    const { t, owner, workspaceId } = await ownerAndWorkspace();
    await bindFakeStorage(t, owner, workspaceId);

    const stored = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    expect(stored?.forcePathStyle).toBeUndefined();

    const visible = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(visible?.forcePathStyle).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

describe("a virtual-hosted bucket actually connects", () => {
  /**
   * The whole point, end to end, against a backend that models virtual-hosted
   * addressing properly: the bucket is the host label and the path is the key,
   * so a path-style request lands on the key `<bucket>/<key>` and the probe
   * would fail. Only a correctly-addressed store passes this.
   */
  test("forcePathStyle: false reaches connected", async () => {
    const { t, owner, workspaceId } = await ownerAndWorkspace();
    const backend = memoryS3(VIRTUAL_BUCKET, { virtualHosted: true });
    vi.stubGlobal("fetch", backend.fetchImpl);

    await bindFakeStorage(t, owner, workspaceId, {
      endpoint: VIRTUAL_ENDPOINT,
      bucket: VIRTUAL_BUCKET,
      forcePathStyle: false,
    });
    await drainScheduled(t);

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.status).toBe("connected");
    expect(binding?.lastError).toBeUndefined();
    expect(binding?.errorCode).toBeUndefined();
    expect(binding?.forcePathStyle).toBe(false);
  });

  /**
   * The sabotage. Same endpoint, same backend, the *wrong* answer — and it must
   * fail, or the test above proves nothing about addressing and would pass with
   * `forcePathStyle` ignored entirely.
   */
  test("the wrong answer against the same backend does not connect", async () => {
    const { t, owner, workspaceId } = await ownerAndWorkspace();
    const backend = memoryS3(VIRTUAL_BUCKET, { virtualHosted: true });
    vi.stubGlobal("fetch", backend.fetchImpl);

    await bindFakeStorage(t, owner, workspaceId, {
      endpoint: VIRTUAL_ENDPOINT,
      bucket: VIRTUAL_BUCKET,
      forcePathStyle: true,
    });
    await drainScheduled(t);

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.status).toBe("error");
    expect(binding?.errorCode).toBe("UNREACHABLE");
    // …and the reason is visible in what the backend was actually asked for:
    // the bucket name ended up in the **key**, because a path-style request put
    // it in the path of a host that already carried it. On a real provider that
    // is not a 404, it is a different key space — the silent wrong-bucket write
    // this whole field exists to prevent.
    expect(
      backend.requests.some(
        (request) =>
          request.key === VIRTUAL_BUCKET ||
          request.key.startsWith(`${VIRTUAL_BUCKET}/`),
      ),
      `the probe addressed ${JSON.stringify(backend.requests)}`,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe("the answer reaches the gateway", () => {
  /**
   * The gateway builds the store that signs real requests. If the control plane
   * keeps the addressing style to itself, the probe and the gateway address the
   * bucket differently and a binding certified here fails there.
   */
  test("openStorageBinding emits forcePathStyle, and omits it when unset", async () => {
    for (const forcePathStyle of [false, true, undefined]) {
      const { t, owner, workspaceId } = await ownerAndWorkspace();
      const backend = memoryS3(
        forcePathStyle === false ? VIRTUAL_BUCKET : FAKE_STORAGE.bucket,
        { virtualHosted: forcePathStyle === false },
      );
      vi.stubGlobal("fetch", backend.fetchImpl);

      await bindFakeStorage(t, owner, workspaceId, {
        ...(forcePathStyle === undefined
          ? {}
          : {
              endpoint: VIRTUAL_ENDPOINT,
              bucket: VIRTUAL_BUCKET,
              forcePathStyle,
            }),
      });

      const credential = await t.action(
        internal.functions.storage.getBindingForGateway,
        { workspaceId },
      );
      // An S3 fixture: the credential union only carries this on the bucket
      // shape, and a Dropbox binding reaching here would be the bug.
      expect(credential?.provider).not.toBe("dropbox");
      expect(
        (credential as { forcePathStyle?: boolean } | null)?.forcePathStyle,
      ).toBe(forcePathStyle);
      // The gateway's contract calls this field optional; absent must stay
      // absent rather than becoming a `false` that flips a path-style bucket.
      if (forcePathStyle === undefined) {
        expect(credential).not.toHaveProperty("forcePathStyle", false);
      }
    }
  });

  /**
   * …and over the actual wire.
   *
   * `getBindingForGateway` is not what the gateway calls. `/gateway/binding`
   * is, through `openStorageBinding`, and that is a second return validator
   * with a second field list — a field can be plumbed correctly all the way to
   * the last hop and dropped there, which is a bug no test of the inner
   * function can see.
   */
  test("/gateway/binding carries the addressing style to the gateway", async () => {
    const accessToken = `cat_addressing_${"0".repeat(20)}`;
    const { t, owner, workspaceId } = await ownerAndWorkspace();
    await seedStorageBinding(t, {
      workspaceId,
      boundBy: owner,
      status: "connected",
      endpoint: VIRTUAL_ENDPOINT,
      bucket: VIRTUAL_BUCKET,
      forcePathStyle: false,
    });
    await t.run(async (ctx) =>
      ctx.db.insert("oauthGrants", {
        workspaceId,
        userId: owner,
        clientId: "mcp_client_alpha",
        scopes: ["context:read"],
        hashedRefreshToken: await hashToken(`${accessToken}-refresh`),
        hashedAccessToken: await hashToken(accessToken),
        accessTokenExpiresAt: Date.now() + 3_600_000,
        status: "active" as const,
        createdAt: Date.now(),
      }),
    );
    await gatewayPost(t, "/gateway/clients/register", {
      clientId: "mcp_client_alpha",
      clientName: "Example AI Client",
      redirectUris: ["https://client.example/callback"],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
    });

    const response = await gatewayPost(t, "/gateway/binding", {
      accessToken,
      expectedWorkspaceId: null,
    });
    const body = JSON.parse(await response.text()) as {
      binding: { forcePathStyle?: boolean; bucket: string } | null;
    };

    expect(body.binding?.bucket).toBe(VIRTUAL_BUCKET);
    expect(body.binding?.forcePathStyle).toBe(false);
  });
});
