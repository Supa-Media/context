import { describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import {
  setupTest,
} from "../fixtures.helpers";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { decryptSecret, encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { deriveS3SecretAccessKey } from "../../functions/lib/cloudflare";
import {
  ACCOUNT_ID,
  OPERATOR_TOKEN,
  MINTED_TOKEN,
  MINTED_ID,
  stubCloudflare,
  paidContext,
  configured,
  binding,
} from "./fixtures";

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

      const status = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
      expect(status?.managedProvisioning).toBe("running");
      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      const verification = scheduled.find((job) =>
        job.name.includes("verifyStorageBinding"),
      );
      const verificationArgs = (
        verification?.args as Array<{
          workspaceId: string;
          retryUntil?: number;
        }> | undefined
      )?.[0];
      expect(verificationArgs).toMatchObject({ workspaceId });
      expect(verificationArgs?.retryUntil).toBeGreaterThan(Date.now() + 110_000);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("becomes ready only after the managed bucket answers", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { owner, workspaceId } = await paidContext(t, "verified-ready");
      await t.action(internal.functions.managedProvisioning.provisionManagedStorage, {
        workspaceId,
      });

      await t.mutation(internal.functions.storage.recordVerification, {
        workspaceId,
        actorUserId: owner,
        ok: true,
        capabilities: { conditionalWrite: true },
      });

      const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
      expect(plan?.managedProvisioning).toBe("ready");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("keeps propagation failures amber until the two-minute deadline", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { owner, workspaceId } = await paidContext(t, "propagation-window");
      await t.action(internal.functions.managedProvisioning.provisionManagedStorage, {
        workspaceId,
      });

      await t.action(internal.functions.provisioning.verifyStorageBinding, {
        workspaceId,
        actorUserId: owner,
        retryUntil: Date.now() + 120_000,
      });
      expect((await binding(t))?.status).toBe("unverified");
      expect(await t.run((ctx) => ctx.db.query("workspacePlans").unique())).toMatchObject({
        managedProvisioning: "running",
      });

      await t.action(internal.functions.provisioning.verifyStorageBinding, {
        workspaceId,
        actorUserId: owner,
        retryUntil: Date.now() - 1,
      });
      expect((await binding(t))?.status).toBe("error");
      expect(await t.run((ctx) => ctx.db.query("workspacePlans").unique())).toMatchObject({
        managedProvisioning: "failed",
      });
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
        processed: 1,
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
    expect(migration?.objectsTotal).toBeUndefined();
  });

});
