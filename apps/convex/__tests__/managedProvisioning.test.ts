/**
 * THE BUCKET A CUSTOMER PAID FOR, AND THE FOUR WAYS THAT GOES WRONG.
 *
 * Managed provisioning is the one flow in this product where a failure happens
 * **after** money has changed hands, so what these assert is mostly what it
 * refuses to do:
 *
 * 1. **A retry cannot make a second bucket.** The screen after a failure says
 *    so in exactly those words, and it is true because the bucket is named
 *    from the immutable workspace id and an existing one is adopted. If this
 *    ever stops holding, somebody who pressed twice owns two buckets and their
 *    notes are in one of them.
 * 2. **It never replaces a live binding before a verified copy.** A binding is
 *    what a person's notes are behind. A redelivered webhook, or a customer
 *    who reconnects while copying, must not lose them.
 * 3. **Neither credential is ever stored.** Not the operator token it opens,
 *    and not the token it mints — what goes in the row is the SHA-256 the S3
 *    API expects, which cannot be turned back into a token.
 * 4. **A managed binding is indistinguishable from a pasted one**, because the
 *    gateway, the adapter and the privacy engine must have no idea who is
 *    paying (`storage-and-credentials.md`).
 *
 * Everything here drives a stubbed Cloudflare. Nothing in this file has run
 * against the real API — there is no managed account in this environment — so
 * the request *shapes* are documentation-derived and only the behaviour around
 * them is proven. The module header says the same and says what to check on
 * the first live run.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   adoption removed, so a taken name fails the retry                     1
 *   cutover accepting a different source binding                          1
 *   the minted token stored instead of its digest                        1
 *   the entitlement check dropped, so an unpaid context provisions        1
 *   the webhook scheduling provisioning for a plan with no managed choice 1
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  seedAppSecret,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import {
  MANAGED_R2_ACCOUNT_ID_ENV_VAR,
  MANAGED_R2_API_TOKEN_SECRET,
  managedBucketName,
} from "../functions/lib/managedStorage";
import {
  decryptSecret,
  encryptSecret,
  requireKeyset,
} from "../functions/lib/crypto";
import { deriveS3SecretAccessKey } from "../functions/lib/cloudflare";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const OPERATOR_TOKEN = "cf_operator_obviously_fake";
const MINTED_TOKEN = "cf_minted_obviously_fake";
const MINTED_ID = "0123456789abcdef0123456789abcde0";

/**
 * Cloudflare, as a script of answers.
 *
 * Every call is recorded so a test can assert what was *not* asked as well as
 * what was — "the bucket was created once" is a claim about the absence of a
 * second call.
 */
function stubCloudflare(
  options: { bucketTaken?: boolean; mintFails?: boolean } = {},
) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const ok = (result: unknown) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, errors: [], result }),
    });
    if (url.includes("/tokens/permission_groups")) {
      return ok([
        { id: "pg_write", name: "Workers R2 Storage Bucket Item Write" },
      ]);
    }
    if (url.includes("/r2/buckets") && method === "POST") {
      if (options.bucketTaken === true) {
        return {
          ok: false,
          status: 409,
          text: async () =>
            JSON.stringify({
              success: false,
              errors: [
                {
                  code: 10004,
                  message: "The bucket you tried to create already exists",
                },
              ],
            }),
        };
      }
      return ok({ name: "created" });
    }
    if (url.includes("/tokens") && method === "POST") {
      if (options.mintFails === true) {
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({
              success: false,
              errors: [{ code: 9109, message: "Unauthorized" }],
            }),
        };
      }
      return ok({ id: MINTED_ID, value: MINTED_TOKEN });
    }
    return ok({});
  });
  return { calls };
}

async function paidContext(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug);
  await t.run(async (ctx) => {
    await ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  return { owner, workspaceId };
}

async function configured(t: TestConvex) {
  await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, OPERATOR_TOKEN);
  vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, ACCOUNT_ID);
}

function binding(t: TestConvex) {
  return t.run((ctx) => ctx.db.query("storageBindings").unique());
}

describe("provisioning a managed bucket", () => {
  test("creates the bucket, mints a key, and binds it", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { workspaceId } = await paidContext(t, "provisions");
      const result = await t.action(
        internal.functions.managedProvisioning.provisionManagedStorage,
        { workspaceId },
      );

      expect(result.ok).toBe(true);
      const row = await binding(t);
      expect(row?.provider).toBe("r2");
      expect(row?.bucket).toBe(managedBucketName(workspaceId));
      expect(row?.endpoint).toContain(ACCOUNT_ID);
      expect(row?.accessKeyId).toBe(MINTED_ID);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("and neither credential is anywhere in the database", async () => {
    /*
      The operator token can create buckets in our account; the minted token can
      act on this one. Neither is a thing to keep. What the row holds is the
      SHA-256 of the minted value, encrypted — which is what R2's S3 API
      expects as a secret access key and cannot be turned back into a token.
    */
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { workspaceId } = await paidContext(t, "no-secrets");
      await t.action(
        internal.functions.managedProvisioning.provisionManagedStorage,
        {
          workspaceId,
        },
      );

      const everything = await t.run(async (ctx) => {
        const bindings = await ctx.db.query("storageBindings").collect();
        const plans = await ctx.db.query("workspacePlans").collect();
        const audit = await ctx.db.query("auditEvents").collect();
        return JSON.stringify({ bindings, plans, audit });
      });
      expect(everything).not.toContain(OPERATOR_TOKEN);
      expect(everything).not.toContain(MINTED_TOKEN);

      /*
        AND THE STORED VALUE IS THE DIGEST, NOT THE TOKEN.

        The two assertions above are weaker than they look and the sabotage
        pass proved it: the secret is encrypted either way, so storing the raw
        minted token instead of its SHA-256 passed both of them. The only
        assertion that can tell the difference opens the envelope.

        It matters because the two are not interchangeable. The digest is what
        R2's S3 API expects as a secret access key and can do nothing else; the
        token it came from is a live Cloudflare API credential.
      */
      const row = await binding(t);
      // Asserted rather than asserted-away: `encryptedSecretAccessKey` is
      // optional on the row (a Dropbox binding has none), so a run that wrote
      // no secret at all would otherwise reach the decrypt below as
      // `undefined` and this test would be about nothing.
      expect(row?.encryptedSecretAccessKey).toBeDefined();
      const stored = await decryptSecret(
        row!.encryptedSecretAccessKey!,
        requireKeyset(),
        {
          workspaceId: row!.workspaceId,
        },
      );
      expect(stored).toBe(await deriveS3SecretAccessKey(MINTED_TOKEN));
      expect(stored).not.toBe(MINTED_TOKEN);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("a retry adopts the bucket it already made rather than making another", async () => {
    /*
      THE PROMISE THE FAILURE SCREEN MAKES, IN CODE.

      "Trying again is safe and will not create a second copy of anything" is
      only true because the name is derived from the immutable workspace id and
      a taken name in *our* account is this workspace's own bucket. The BYO
      path cannot assume that and does not; this one can and must.
    */
    const t = setupTest();
    const cloudflare = stubCloudflare({ bucketTaken: true });
    try {
      await configured(t);
      const { workspaceId } = await paidContext(t, "adopts");
      const result = await t.action(
        internal.functions.managedProvisioning.provisionManagedStorage,
        { workspaceId },
      );

      expect(result.ok).toBe(true);
      expect((await binding(t))?.bucket).toBe(managedBucketName(workspaceId));
      // One create attempt, one mint. No second name was tried.
      const creates = cloudflare.calls.filter(
        (call) => call.url.includes("/r2/buckets") && call.method === "POST",
      );
      expect(creates).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("an existing binding stays live while a resumable migration is parked", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { owner, workspaceId } = await paidContext(t, "already-bound");
      const sourceSecret = await encryptSecret(
        "source-secret",
        requireKeyset(),
        {
          workspaceId,
        },
      );
      await t.run((ctx) =>
        ctx.db.insert("storageBindings", {
          workspaceId,
          provider: "s3",
          endpoint: "https://s3.example.invalid",
          region: "us-east-1",
          bucket: "their-own-bucket",
          accessKeyId: "AKIAFAKE",
          encryptedSecretAccessKey: sourceSecret,
          status: "connected",
          capabilities: { conditionalWrite: true },
          boundBy: owner,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );

      const result = await t.action(
        internal.functions.managedProvisioning.provisionManagedStorage,
        { workspaceId },
      );

      expect(result.ok).toBe(true);
      expect((await binding(t))?.bucket).toBe("their-own-bucket");
      const migration = await t.run((ctx) =>
        ctx.db.query("managedStorageMigrations").unique(),
      );
      expect(migration?.sourceBindingId).toBe((await binding(t))?._id);
      expect(migration?.targetBucket).toBe(managedBucketName(workspaceId));
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("a changed verification pass repeats and only a quiet pass permits cutover", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await paidContext(t, "quiet-pass");
    const sourceBindingId = await t.run((ctx) =>
      ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "s3",
        endpoint: "https://s3.example.invalid",
        region: "us-east-1",
        bucket: "source",
        accessKeyId: "source-key",
        encryptedSecretAccessKey: "sealed-source",
        status: "connected",
        capabilities: { conditionalWrite: true },
        boundBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("managedStorageMigrations", {
        workspaceId,
        sourceBindingId,
        targetEndpoint: "https://managed.example.invalid",
        targetBucket: managedBucketName(workspaceId),
        targetAccessKeyId: "target-key",
        encryptedTargetSecretAccessKey: "sealed-target",
        status: "copying",
        phase: "copy",
        objectsCopied: 0,
        changesInPass: 0,
        readyToCutover: false,
        startedBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const page = (changes: number) =>
      t.mutation(internal.functions.managedProvisioning.recordMigrationPage, {
        workspaceId,
        copied: 1,
        changes,
      });
    expect((await page(1)).cutover).toBe(false); // copy -> verify source
    expect((await page(1)).cutover).toBe(false); // verify source -> verify target
    expect((await page(0)).cutover).toBe(false); // changed pass -> repeat
    expect((await page(0)).cutover).toBe(false); // quiet source -> target
    expect((await page(0)).cutover).toBe(true); // quiet target -> cutover

    const migration = await t.run((ctx) =>
      ctx.db.query("managedStorageMigrations").unique(),
    );
    expect(migration?.readyToCutover).toBe(true);
  });

  test("a reconnect during the copy refuses cutover and leaves the new binding live", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await paidContext(t, "reconnect-race");
    const oldBindingId = await t.run((ctx) =>
      ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "s3",
        endpoint: "https://old.example.invalid",
        region: "us-east-1",
        bucket: "old-source",
        accessKeyId: "old",
        encryptedSecretAccessKey: "old-secret",
        status: "connected",
        capabilities: { conditionalWrite: true },
        boundBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("managedStorageMigrations", {
        workspaceId,
        sourceBindingId: oldBindingId,
        targetEndpoint: "https://managed.example.invalid",
        targetBucket: managedBucketName(workspaceId),
        targetAccessKeyId: "target",
        encryptedTargetSecretAccessKey: "target-secret",
        status: "copying",
        phase: "verify_target",
        objectsCopied: 3,
        changesInPass: 0,
        readyToCutover: true,
        startedBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(oldBindingId);
      await ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "s3",
        endpoint: "https://new.example.invalid",
        region: "us-east-1",
        bucket: "new-source",
        accessKeyId: "new",
        encryptedSecretAccessKey: "new-secret",
        status: "connected",
        capabilities: { conditionalWrite: true },
        boundBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const result = await t.mutation(
      internal.functions.managedProvisioning.finishManagedStorageMigration,
      { workspaceId },
    );
    expect(result.cutover).toBe(false);
    expect((await binding(t))?.bucket).toBe("new-source");

    const resumed = await t.mutation(
      internal.functions.managedProvisioning.resumeManagedStorageMigration,
      { workspaceId, actorUserId: owner },
    );
    expect(resumed).toBe(true);
    const migration = await t.run((ctx) =>
      ctx.db.query("managedStorageMigrations").unique(),
    );
    expect(migration?.sourceBindingId).toBe((await binding(t))?._id);
    expect(migration?.phase).toBe("copy");
    expect(migration?.objectsCopied).toBe(0);
  });

  test("nor over one that appeared while Cloudflare was answering", async () => {
    /*
      THE RACE, WHICH THE TEST ABOVE DOES NOT REACH.

      That one returns early — the binding is already there when the action
      starts, and the guard inside `completeManagedProvisioning` never runs.
      The sabotage pass proved it: removing that guard failed nothing.

      This is the case it exists for. The customer connected their own bucket
      in the seconds Cloudflare took to answer, so the action is finishing a
      job whose premise has expired, and the row it is about to write would sit
      on top of the storage their notes are already in.
    */
    const t = setupTest();
    try {
      const { owner, workspaceId } = await paidContext(t, "race");
      await t.run((ctx) =>
        ctx.db.insert("storageBindings", {
          workspaceId,
          provider: "s3",
          endpoint: "https://s3.example.invalid",
          region: "us-east-1",
          bucket: "arrived-first",
          accessKeyId: "AKIAFAKE",
          encryptedSecretAccessKey: "v2:fake",
          status: "connected",
          capabilities: { conditionalWrite: true },
          boundBy: owner,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );

      await t.mutation(
        internal.functions.managedProvisioning.completeManagedProvisioning,
        {
          workspaceId,
          actorUserId: owner,
          endpoint: "https://managed.example.invalid",
          bucket: managedBucketName(workspaceId),
          accessKeyId: MINTED_ID,
          encryptedSecretAccessKey: "v2:managed",
        },
      );

      expect((await binding(t))?.bucket).toBe("arrived-first");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a context that is not paying for it gets nothing", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const owner = await createUser(t, "unpaid@example.invalid");
      const workspaceId = await createWorkspace(t, owner, "unpaid");
      const result = await t.action(
        internal.functions.managedProvisioning.provisionManagedStorage,
        { workspaceId },
      );

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_ENTITLED");
      expect(await binding(t)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("a deployment with no account says so rather than blaming Cloudflare", async () => {
    const t = setupTest();
    const cloudflare = stubCloudflare();
    try {
      const { workspaceId } = await paidContext(t, "unconfigured");
      const result = await t.action(
        internal.functions.managedProvisioning.provisionManagedStorage,
        { workspaceId },
      );

      expect(result.errorCode).toBe("NOT_CONFIGURED");
      // And nothing was asked of Cloudflare at all.
      expect(cloudflare.calls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a refusal is recorded as our code, and the customer can retry", async () => {
    const t = setupTest();
    stubCloudflare({ mintFails: true });
    try {
      await configured(t);
      const { owner, workspaceId } = await paidContext(t, "refused");
      const result = await t.action(
        internal.functions.managedProvisioning.provisionManagedStorage,
        { workspaceId },
      );

      expect(result.errorCode).toBe("CLOUDFLARE_REFUSED");
      const status = await asUser(t, owner).query(
        api.functions.billing.status,
        {
          workspaceId,
        },
      );
      expect(status.managedProvisioning).toBe("failed");
      expect(status.managedProvisioningError).toBe("CLOUDFLARE_REFUSED");
      // Nothing half-written: no binding, so nothing downstream believes there
      // is storage here.
      expect(await binding(t)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("a member is not told which of our systems refused", async () => {
    // The money fields are owner-only on the wire and this is one of them: a
    // member cannot act on it, and "Cloudflare refused" is our infrastructure
    // rather than their business.
    const t = setupTest();
    stubCloudflare({ mintFails: true });
    try {
      await configured(t);
      const { workspaceId } = await paidContext(t, "member-view");
      await t.action(
        internal.functions.managedProvisioning.provisionManagedStorage,
        {
          workspaceId,
        },
      );
      const member = await createUser(t, "member-view-2@example.invalid");
      await addMember(t, workspaceId, member, "member");

      const status = await asUser(t, member).query(
        api.functions.billing.status,
        {
          workspaceId,
        },
      );
      expect(status.managedProvisioning).toBe("failed");
      expect(status.managedProvisioningError).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("only an owner can ask for another go", async () => {
    const t = setupTest();
    try {
      await configured(t);
      const { workspaceId } = await paidContext(t, "retry-auth");
      const member = await createUser(t, "retry-auth-2@example.invalid");
      await addMember(t, workspaceId, member, "member");

      await expect(
        asUser(t, member).mutation(
          api.functions.managedProvisioning.retryManagedProvisioning,
          {
            workspaceId,
          },
        ),
      ).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
