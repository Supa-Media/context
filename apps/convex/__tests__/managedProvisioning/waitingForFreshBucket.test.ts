import { describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import {
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import {
  ACCOUNT_ID,
  MINTED_ID,
  binding,
  configured,
  paidContext,
  stubCloudflare,
} from "./fixtures";

describe("waiting for a managed bucket that has only just been made", () => {
  /*
    WHAT THIS IS ABOUT, AND THE BUG IT COMES FROM.

    A customer upgraded a context that already had storage. Cloudflare answered
    every provisioning call, the copy began against the bucket it had just
    made, and the screen came back saying the copy stopped before anything was
    switched. Pressing "Try copy again" a minute later worked first time.

    That shape — fails once, succeeds on a retry that changes nothing — is a
    race, not a broken bucket. A freshly minted bucket-scoped token is not
    usable at R2's S3 endpoint the instant Cloudflare's API returns it, and the
    copy started in the same tick. The BYO path already waits two minutes for
    exactly this (`verificationRetryUntil`); the migration path did not wait at
    all, and treated the first error of any kind as final.

    So: prove the target answers before moving anything, and let a blip during
    the copy be retried rather than ending a migration that is half done.
  */

  /** A target whose S3 endpoint refuses until `readyAfter` calls have passed. */
  function stubSettlingTarget(options: { readyAfter: number }) {
    const state = { s3Calls: 0, objects: new Map<string, string>() };
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      state.s3Calls += 1;
      if (state.s3Calls <= options.readyAfter) {
        // What R2 actually says while a new token propagates.
        return {
          ok: false,
          status: 401,
          text: async () =>
            "<Error><Code>InvalidAccessKeyId</Code></Error>",
          headers: new Headers(),
        };
      }
      const key = decodeURIComponent(new URL(url).pathname.slice(1).split("/").slice(1).join("/"));
      if (method === "PUT") {
        state.objects.set(key, "probe");
        return { ok: true, status: 200, text: async () => "", headers: new Headers({ etag: '"abc"' }) };
      }
      if (method === "DELETE") {
        state.objects.delete(key);
        return { ok: true, status: 204, text: async () => "", headers: new Headers() };
      }
      if (method === "GET" && url.includes("list-type=2")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
          headers: new Headers(),
        };
      }
      return { ok: true, status: 200, text: async () => "probe", headers: new Headers({ etag: '"abc"' }) };
    });
    return state;
  }

  async function migratingContext(t: TestConvex, slug: string) {
    const { owner, workspaceId } = await paidContext(t, slug);
    const sourceBindingId = await t.run(async (ctx) =>
      ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "s3",
        endpoint: "https://s3.example.invalid",
        region: "us-east-1",
        bucket: "their-own-bucket",
        accessKeyId: "AKIAFAKE",
        encryptedSecretAccessKey: await encryptSecret("source-secret", requireKeyset(), {
          workspaceId,
        }),
        status: "connected",
        capabilities: { conditionalWrite: true },
        boundBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("managedStorageMigrations", {
        workspaceId,
        sourceBindingId,
        targetEndpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
        targetBucket: managedBucketName(workspaceId),
        targetAccessKeyId: MINTED_ID,
        encryptedTargetSecretAccessKey: await encryptSecret(
          "target-secret",
          requireKeyset(),
          { workspaceId },
        ),
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
    return { owner, workspaceId, sourceBindingId };
  }

  const migrationRow = (t: TestConvex) =>
    t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
  const plan = (t: TestConvex) =>
    t.run((ctx) => ctx.db.query("workspacePlans").unique());
  const scheduledNames = async (t: TestConvex) =>
    (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).map(
      (job) => job.name,
    );

  test("an upgrade queues the wait, never the copy", async () => {
    /*
      THE WIRING, WHICH THE GATE'S OWN TESTS DO NOT REACH.

      Those call `awaitManagedTargetReady` directly and prove it waits. This
      proves it is what an upgrade actually reaches — remove the gate from
      `beginManagedStorageMigration` and the copy starts in the same tick as
      the mint again, which is the whole bug, and every other test here would
      still pass.
    */
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { workspaceId } = await migratingContext(t, "queues-the-wait");
      await t.run(async (ctx) => {
        const row = await ctx.db.query("managedStorageMigrations").unique();
        await ctx.db.delete(row!._id);
      });

      await t.action(
        internal.functions.managedProvisioning.provisionManagedStorage,
        { workspaceId },
      );

      const names = await scheduledNames(t);
      expect(names.some((name) => name.includes("awaitManagedTargetReady"))).toBe(true);
      expect(names.some((name) => name.includes("runManagedStorageMigration"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("and so does a retry of one that failed", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { workspaceId } = await migratingContext(t, "retry-queues-wait");
      await t.run(async (ctx) => {
        const row = await ctx.db.query("managedStorageMigrations").unique();
        await ctx.db.patch(row!._id, { status: "failed", errorCode: "COPY_FAILED" });
      });

      await t.action(
        internal.functions.managedProvisioning.provisionManagedStorage,
        { workspaceId },
      );

      const names = await scheduledNames(t);
      expect(names.some((name) => name.includes("awaitManagedTargetReady"))).toBe(true);
      expect(names.some((name) => name.includes("runManagedStorageMigration"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("the copy does not begin until the new bucket answers", async () => {
    const t = setupTest();
    stubSettlingTarget({ readyAfter: 50 });
    try {
      const { workspaceId } = await migratingContext(t, "settling-target");

      await t.action(
        internal.functions.managedProvisioning.awaitManagedTargetReady,
        { workspaceId, retryUntil: Date.now() + 120_000 },
      );

      // Nothing moved, nothing failed, and the source is still what serves the
      // customer. The wait is the whole behaviour.
      expect(await migrationRow(t)).toMatchObject({ status: "copying", phase: "count" });
      expect(await plan(t)).not.toMatchObject({ managedProvisioning: "failed" });
      const names = await scheduledNames(t);
      expect(names.some((name) => name.includes("awaitManagedTargetReady"))).toBe(true);
      expect(names.some((name) => name.includes("runManagedStorageMigration"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("and begins as soon as it does", async () => {
    const t = setupTest();
    stubSettlingTarget({ readyAfter: 0 });
    try {
      const { workspaceId } = await migratingContext(t, "settled-target");

      await t.action(
        internal.functions.managedProvisioning.awaitManagedTargetReady,
        { workspaceId, retryUntil: Date.now() + 120_000 },
      );

      const names = await scheduledNames(t);
      expect(names.some((name) => name.includes("runManagedStorageMigration"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a bucket that never answers fails honestly rather than waiting forever", async () => {
    const t = setupTest();
    stubSettlingTarget({ readyAfter: 50 });
    try {
      const { workspaceId } = await migratingContext(t, "never-answers");

      await t.action(
        internal.functions.managedProvisioning.awaitManagedTargetReady,
        { workspaceId, retryUntil: Date.now() - 1 },
      );

      expect(await migrationRow(t)).toMatchObject({
        status: "failed",
        errorCode: "TARGET_NOT_READY",
      });
      // The plan has to say failed too, or the console shows a copy that is
      // making progress forever with no way to retry.
      expect(await plan(t)).toMatchObject({ managedProvisioning: "failed" });
      expect((await binding(t))?.bucket).toBe("their-own-bucket");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a blip mid-copy is retried, not treated as the end of the migration", async () => {
    const t = setupTest();
    stubSettlingTarget({ readyAfter: 50 });
    try {
      const { workspaceId } = await migratingContext(t, "mid-copy-blip");

      await t.action(
        internal.functions.managedProvisioning.runManagedStorageMigration,
        { workspaceId },
      );

      expect(await migrationRow(t)).toMatchObject({ status: "copying" });
      expect(await plan(t)).not.toMatchObject({ managedProvisioning: "failed" });
      const names = await scheduledNames(t);
      expect(names.some((name) => name.includes("runManagedStorageMigration"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("but a blip that outlasts the window stops and says so", async () => {
    const t = setupTest();
    stubSettlingTarget({ readyAfter: 50 });
    try {
      const { workspaceId } = await migratingContext(t, "blip-outlasts");

      await t.action(
        internal.functions.managedProvisioning.runManagedStorageMigration,
        { workspaceId, retryUntil: Date.now() - 1 },
      );

      expect(await migrationRow(t)).toMatchObject({ status: "failed" });
      expect(await plan(t)).toMatchObject({ managedProvisioning: "failed" });
      expect((await binding(t))?.bucket).toBe("their-own-bucket");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a page that lands resets the window the next one gets", async () => {
    /*
      The retry deadline is for one unbroken run of failures, not for the
      migration. A copy of a thousand objects that hits a blip at object nine
      hundred must not then be on a clock that started at object one — so a
      page that lands schedules its successor with no deadline at all.
    */
    const t = setupTest();
    stubSettlingTarget({ readyAfter: 0 });
    try {
      const { workspaceId } = await migratingContext(t, "window-resets");

      await t.action(
        internal.functions.managedProvisioning.runManagedStorageMigration,
        { workspaceId, retryUntil: Date.now() + 1_000 },
      );

      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      const next = scheduled.find((job) =>
        job.name.includes("runManagedStorageMigration"),
      );
      expect(next).toBeDefined();
      expect(
        (next?.args as Array<{ retryUntil?: number }>)[0]?.retryUntil,
      ).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a failing page keeps its deadline across the retry", async () => {
    const t = setupTest();
    stubSettlingTarget({ readyAfter: 50 });
    try {
      const { workspaceId } = await migratingContext(t, "window-carries");
      const deadline = Date.now() + 90_000;

      await t.action(
        internal.functions.managedProvisioning.runManagedStorageMigration,
        { workspaceId, retryUntil: deadline },
      );

      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      const next = scheduled.find((job) =>
        job.name.includes("runManagedStorageMigration"),
      );
      expect(
        (next?.args as Array<{ retryUntil?: number }>)[0]?.retryUntil,
      ).toBe(deadline);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a deterministic refusal is not retried into the deadline", async () => {
    /*
      Retrying is for a bucket that has not settled. An object the copy is not
      allowed to move is the same answer every time, and burning two minutes of
      retries on it just delays the message the owner needs.
    */
    const t = setupTest();
    const { workspaceId } = await migratingContext(t, "too-large");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("managedStorageMigrations").unique();
      await ctx.db.patch(row!._id, { phase: "copy" });
    });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("list-type=2")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
            "<Contents><Key>big.md</Key><Size>99999999</Size>" +
            "<LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>",
          headers: new Headers(),
        };
      }
      return { ok: true, status: 200, text: async () => "x", headers: new Headers({ etag: '"a"' }) };
    });
    try {
      await t.action(
        internal.functions.managedProvisioning.runManagedStorageMigration,
        { workspaceId },
      );

      expect(await migrationRow(t)).toMatchObject({
        status: "failed",
        errorCode: "OBJECT_TOO_LARGE",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a stalled cursor fails the plan, not just the row", async () => {
    /*
      `recordMigrationPage` refuses a page whose cursor did not advance, which
      is right. It used to fail the migration row and leave the plan reading
      `running`, and the console reads the plan — so the owner watched a copy
      that had already stopped, with no retry offered.
    */
    const t = setupTest();
    const { workspaceId } = await migratingContext(t, "stalled-cursor");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("managedStorageMigrations").unique();
      await ctx.db.patch(row!._id, { cursor: "stuck" });
    });

    const progress = await t.mutation(
      internal.functions.managedProvisioning.recordMigrationPage,
      {
        workspaceId,
        expectedCursor: "stuck",
        nextCursor: "stuck",
        copied: 0,
        changes: 0,
        processed: 0,
      },
    );

    expect(progress.applied).toBe(false);
    expect(await migrationRow(t)).toMatchObject({
      status: "failed",
      errorCode: "CURSOR_STALLED",
    });
    expect(await plan(t)).toMatchObject({ managedProvisioning: "failed" });
  });
});
