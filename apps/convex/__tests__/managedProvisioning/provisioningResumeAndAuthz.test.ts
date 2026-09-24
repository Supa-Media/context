import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  setupTest,
} from "../fixtures.helpers";
import { managedBucketName } from "../../functions/lib/managedStorage";
import {
  MINTED_ID,
  stubCloudflare,
  paidContext,
  configured,
  binding,
} from "./fixtures";

describe("provisioning a managed bucket", () => {
  test("counts first, then exposes resumable phase progress without guessing", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await paidContext(t, "measured-progress");
    const sourceBindingId = await t.run((ctx) =>
      ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "dropbox",
        bucket: "dropbox-source",
        status: "connected",
        capabilities: { conditionalWrite: false },
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
        phase: "count",
        objectsCopied: 0,
        objectsProcessedInPhase: 0,
        changesInPass: 0,
        readyToCutover: false,
        startedBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await t.mutation(internal.functions.managedProvisioning.recordMigrationPage, {
      workspaceId,
      nextCursor: "second-page",
      copied: 0,
      changes: 0,
      processed: 25,
    });
    let migration = await t.run((ctx) =>
      ctx.db.query("managedStorageMigrations").unique(),
    );
    expect(migration).toMatchObject({
      phase: "count",
      objectsProcessedInPhase: 25,
    });
    expect(migration?.objectsTotal).toBeUndefined();

    await t.mutation(internal.functions.managedProvisioning.recordMigrationPage, {
      workspaceId,
      expectedCursor: "second-page",
      copied: 0,
      changes: 0,
      processed: 5,
    });
    migration = await t.run((ctx) =>
      ctx.db.query("managedStorageMigrations").unique(),
    );
    expect(migration).toMatchObject({
      phase: "copy",
      objectsTotal: 30,
      objectsProcessedInPhase: 0,
    });

    await t.mutation(internal.functions.managedProvisioning.recordMigrationPage, {
      workspaceId,
      nextCursor: "copy-page-2",
      copied: 20,
      changes: 20,
      processed: 24,
    });
    const ownerStatus = await asUser(t, owner).query(
      api.functions.billing.status,
      { workspaceId },
    );
    expect(ownerStatus).toMatchObject({
      managedMigrationPhase: "copy",
      managedMigrationObjectsTotal: 30,
      managedMigrationObjectsProcessed: 24,
      managedMigrationObjectsCopied: 20,
    });

    const member = await createUser(t, "measured-progress-member@example.invalid");
    await addMember(t, workspaceId, member, "member");
    const memberStatus = await asUser(t, member).query(
      api.functions.billing.status,
      { workspaceId },
    );
    expect(memberStatus.managedMigrationPhase).toBeUndefined();
    expect(memberStatus.managedMigrationObjectsTotal).toBeUndefined();
    expect(memberStatus.managedMigrationObjectsProcessed).toBeUndefined();
    expect(memberStatus.managedMigrationObjectsCopied).toBeUndefined();
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
    expect(migration?.phase).toBe("count");
    expect(migration?.objectsCopied).toBe(0);
    expect(migration?.objectsTotal).toBeUndefined();
    expect(migration?.objectsProcessedInPhase).toBe(0);
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

