/**
 * The switch-over of a storage move, and the catch-up passes after it.
 *
 * Two promises are tested here. The new bucket is `connected` the moment the
 * binding swaps, because the move just proved it answers: a binding left
 * `unverified` for the seconds before verification runs has the email worker
 * refuse mail for good, and the gateway answer 503. And a write that lands in
 * the old bucket after the move's last check is brought across by the passes
 * that follow, which carry the old bucket's key sealed, never in the clear.
 *
 * ## Sabotage record
 *
 * Skipping the status patch at cutover left the binding `unverified`, failing
 * the first test. Looking back from the switch instead of from the last
 * check's start failed both `since` tests. Dropping the binding-id check let a
 * pass run against a bucket the workspace had since left, failing "stops when
 * the workspace moved again". Not stamping `passStartedAt` at either start of
 * a check failed the last test.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { FunctionArgs } from "convex/server";
import { FAKE_STORAGE, createUser, createWorkspace, setupTest } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { managedBucketName } from "../functions/lib/managedStorage";
import {
  CATCH_UP_CLOCK_MARGIN_MS,
  CATCH_UP_PASS_DELAYS_MS,
} from "../functions/lib/managedProvisioningFns/constants";

const MANAGED_SECRET = "managed-secret-not-real";
const MANAGED_ENDPOINT = "https://managed-account.r2.cloudflarestorage.example";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface FakeObject {
  body: Uint8Array;
  contentType: string;
  modified: number;
}

/** Path-style S3 buckets by name, with `If-None-Match: *` honoured. */
function fakeS3(buckets: Record<string, Record<string, [string, number]>>) {
  const store = new Map<string, Map<string, FakeObject>>();
  for (const [name, objects] of Object.entries(buckets)) {
    store.set(
      name,
      new Map(
        Object.entries(objects).map(([key, [body, modified]]) => [
          key,
          { body: new TextEncoder().encode(body), contentType: "text/markdown; charset=utf-8", modified },
        ]),
      ),
    );
  }
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const [bucket, ...rest] = url.pathname.slice(1).split("/");
    const key = decodeURIComponent(rest.join("/"));
    requests.push(`${method} ${bucket}/${key}`);
    const objects = store.get(bucket!);
    if (objects === undefined) return new Response("", { status: 404 });
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const contents = [...objects.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([listed, value]) =>
            `<Contents><Key>${listed}</Key><Size>${value.body.byteLength}</Size><LastModified>${new Date(value.modified).toISOString()}</LastModified><ETag>"e"</ETag></Contents>`,
        )
        .join("");
      return new Response(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        { status: 200 },
      );
    }
    if (method === "GET" || method === "HEAD") {
      const found = objects.get(key);
      if (found === undefined) return new Response(null, { status: 404 });
      return new Response(method === "HEAD" ? null : new Blob([found.body as BlobPart]), {
        status: 200,
        headers: {
          "content-type": found.contentType,
          "last-modified": new Date(found.modified).toUTCString(),
          etag: '"e"',
        },
      });
    }
    if (method === "PUT") {
      if (headers.get("if-none-match") === "*" && objects.has(key)) {
        return new Response("", { status: 412 });
      }
      const body = new Uint8Array(init?.body as ArrayBuffer | Uint8Array);
      objects.set(key, {
        body,
        contentType: headers.get("content-type") ?? "application/octet-stream",
        modified: Date.now(),
      });
      return new Response("", { status: 200, headers: { etag: '"e"' } });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 400 });
  });
  return {
    requests,
    read(bucket: string, key: string) {
      const found = store.get(bucket)?.get(key);
      return found === undefined ? null : new TextDecoder().decode(found.body);
    },
  };
}

async function readyToSwitch(options: { passStartedAt?: number } = {}) {
  const t = setupTest();
  const owner = await createUser(t, "catchup-owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "catchup");
  const encrypted = (secret: string) => encryptSecret(secret, requireKeyset(), { workspaceId });
  const managedEnvelope = await encrypted(MANAGED_SECRET);
  const sourceBindingId = await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "r2",
      endpoint: MANAGED_ENDPOINT,
      region: "auto",
      bucket: managedBucketName(workspaceId),
      accessKeyId: "managed-token-id",
      encryptedSecretAccessKey: managedEnvelope,
      status: "connected",
      capabilities: { conditionalWrite: true },
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
      freeManaged: true,
      status: "none",
      managedProvisioning: "ready",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const targetEnvelope = await encrypted(FAKE_STORAGE.secretAccessKey);
  await t.run((ctx) =>
    ctx.db.insert("managedStorageMigrations", {
      workspaceId,
      sourceBindingId,
      direction: "to_customer",
      targetProvider: "r2",
      targetEndpoint: FAKE_STORAGE.endpoint,
      targetRegion: FAKE_STORAGE.region,
      targetBucket: FAKE_STORAGE.bucket,
      targetAccessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedTargetSecretAccessKey: targetEnvelope,
      status: "copying",
      phase: "verify_target",
      objectsCopied: 3,
      objectsProcessedInPhase: 3,
      changesInPass: 0,
      readyToCutover: true,
      targetClaimed: true,
      passStartedAt: options.passStartedAt,
      startedBy: owner,
      createdAt: Date.now() - 60 * 60_000,
      updatedAt: Date.now(),
    }),
  );
  return { t, owner, workspaceId, sourceBindingId, managedEnvelope };
}

const PROBED = {
  conditionalWrite: true,
  conditionalCreate: true,
  conditionalDelete: false,
  serverSideCopy: false,
};

async function catchUpJobs(t: ReturnType<typeof setupTest>) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.filter((job) => job.name.includes("runMoveCatchUp") && job.state.kind === "pending");
}

describe("switching over", () => {
  test("leaves the new bucket connected, with what the move's probe found", async () => {
    const { t, workspaceId } = await readyToSwitch();
    await expect(
      t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, {
        workspaceId,
        capabilities: PROBED,
      }),
    ).resolves.toEqual({ cutover: true });
    const binding = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    expect(binding).toMatchObject({
      bucket: FAKE_STORAGE.bucket,
      status: "connected",
      capabilities: PROBED,
    });
    expect(binding?.lastVerifiedAt).toBeGreaterThan(0);
  });

  test("without a probe answer, the new bucket waits for verification as before", async () => {
    const { t, workspaceId } = await readyToSwitch();
    await t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, {
      workspaceId,
    });
    const binding = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    expect(binding?.status).toBe("unverified");
  });

  test("schedules a catch-up that carries the old bucket's sealed key, never the key", async () => {
    const passStartedAt = Date.now() - 10 * 60_000;
    const { t, workspaceId, managedEnvelope } = await readyToSwitch({ passStartedAt });
    await t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, {
      workspaceId,
      capabilities: PROBED,
    });
    const binding = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    const [job, ...more] = await catchUpJobs(t);
    expect(more).toEqual([]);
    expect(job?.args[0]).toMatchObject({
      workspaceId,
      targetBindingId: binding!._id,
      since: passStartedAt - CATCH_UP_CLOCK_MARGIN_MS,
      direction: "to_customer",
      pass: 0,
      source: {
        provider: "r2",
        bucket: managedBucketName(workspaceId),
        accessKeyId: "managed-token-id",
        encryptedSecretAccessKey: managedEnvelope,
      },
    });
    expect(JSON.stringify(job?.args)).not.toContain(MANAGED_SECRET);
    expect(job!.scheduledTime).toBeGreaterThanOrEqual(Date.now() + CATCH_UP_PASS_DELAYS_MS[0]! - 5_000);
  });

  test("a move from before `passStartedAt` existed looks back to the move's start", async () => {
    const { t, workspaceId } = await readyToSwitch();
    const row = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    await t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, {
      workspaceId,
      capabilities: PROBED,
    });
    const [job] = await catchUpJobs(t);
    expect((job?.args[0] as { since: number }).since).toBe(row!.createdAt - CATCH_UP_CLOCK_MARGIN_MS);
  });

  test("a source without a key pair gets no catch-up and switches over anyway", async () => {
    const { t, workspaceId, sourceBindingId } = await readyToSwitch();
    await t.run((ctx) => ctx.db.patch(sourceBindingId, { accessKeyId: undefined }));
    await t.run(async (ctx) => {
      const plan = await ctx.db.query("workspacePlans").unique();
      const row = await ctx.db.query("managedStorageMigrations").unique();
      await ctx.db.patch(plan!._id, { managedStorage: true });
      await ctx.db.patch(row!._id, { direction: "to_managed" });
    });
    await expect(
      t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, {
        workspaceId,
        capabilities: PROBED,
      }),
    ).resolves.toEqual({ cutover: true });
    expect(await catchUpJobs(t)).toEqual([]);
  });
});

async function switchedOver() {
  const setup = await readyToSwitch({ passStartedAt: Date.now() - 5 * 60_000 });
  await setup.t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, {
    workspaceId: setup.workspaceId,
    capabilities: PROBED,
  });
  const [job] = await catchUpJobs(setup.t);
  const args = job!.args[0] as FunctionArgs<typeof internal.functions.moveCatchUp.runMoveCatchUp>;
  // Run it by hand; drop the queued copy so what is left is what it scheduled.
  await setup.t.run((ctx) => ctx.scheduler.cancel(job!._id));
  return { ...setup, args };
}

describe("the passes after a switch-over", () => {
  test("bring a late write in the old bucket across, and keep the new side's edits", async () => {
    const { t, workspaceId, args } = await switchedOver();
    const now = Date.now();
    const s3 = fakeS3({
      [managedBucketName(workspaceId)]: {
        "0-inbox/late.md": ["arrived by email after the last check", now],
        "plan.md": ["late edit in the old bucket", now],
        "old.md": ["long settled", now - 24 * 60 * 60_000],
      },
      [FAKE_STORAGE.bucket]: {
        "plan.md": ["edit made after the switch", now],
        "old.md": ["long settled, then edited after the switch", now],
      },
    });
    await t.action(internal.functions.moveCatchUp.runMoveCatchUp, args);
    expect(s3.read(FAKE_STORAGE.bucket, "0-inbox/late.md")).toBe("arrived by email after the last check");
    expect(s3.read(FAKE_STORAGE.bucket, "plan.md")).toBe("edit made after the switch");
    expect(s3.read(FAKE_STORAGE.bucket, "plan (saved during the move).md")).toBe(
      "late edit in the old bucket",
    );
    expect(s3.read(FAKE_STORAGE.bucket, "old.md")).toBe("long settled, then edited after the switch");
    expect(s3.read(FAKE_STORAGE.bucket, "old (saved during the move).md")).toBeNull();
    // Nothing is ever written to, or deleted from, the old bucket.
    expect(
      s3.requests.filter(
        (request) =>
          request.includes(managedBucketName(workspaceId)) && !request.startsWith("GET"),
      ),
    ).toEqual([]);

    const [next] = await catchUpJobs(t);
    expect(next?.args[0]).toMatchObject({ pass: 1, since: args.since });
    expect(next?.scheduledTime).toBe(args.cutoverAt + CATCH_UP_PASS_DELAYS_MS[1]!);
  });

  test("stops when the workspace moved again", async () => {
    const { t, workspaceId, args } = await switchedOver();
    await t.run(async (ctx) => {
      const binding = await ctx.db.query("storageBindings").unique();
      const { _id, _creationTime, ...fields } = binding!;
      await ctx.db.delete(_id);
      await ctx.db.insert("storageBindings", { ...fields, bucket: "somewhere-else" });
    });
    const s3 = fakeS3({ [managedBucketName(workspaceId)]: {}, "somewhere-else": {} });
    await t.action(internal.functions.moveCatchUp.runMoveCatchUp, args);
    expect(s3.requests).toEqual([]);
    expect(await catchUpJobs(t)).toEqual([]);
  });

  test("the last pass schedules nothing more", async () => {
    const { t, workspaceId, args } = await switchedOver();
    fakeS3({ [managedBucketName(workspaceId)]: {}, [FAKE_STORAGE.bucket]: {} });
    await t.action(internal.functions.moveCatchUp.runMoveCatchUp, {
      ...args,
      pass: CATCH_UP_PASS_DELAYS_MS.length - 1,
    });
    expect(await catchUpJobs(t)).toEqual([]);
  });

  test("an old bucket that no longer answers moves on to the next pass", async () => {
    const { t, args } = await switchedOver();
    fakeS3({ [FAKE_STORAGE.bucket]: {} });
    await t.action(internal.functions.moveCatchUp.runMoveCatchUp, args);
    const [next] = await catchUpJobs(t);
    expect(next?.args[0]).toMatchObject({ pass: 1 });
  });
});

describe("where the last check begins", () => {
  test("is stamped when a check pass starts", async () => {
    const { t, workspaceId } = await readyToSwitch();
    await t.run(async (ctx) => {
      const row = await ctx.db.query("managedStorageMigrations").unique();
      await ctx.db.patch(row!._id, {
        phase: "copy",
        readyToCutover: false,
        cursor: undefined,
        passStartedAt: undefined,
      });
    });
    const before = Date.now();
    await t.mutation(internal.functions.managedProvisioning.recordMigrationPage, {
      workspaceId,
      copied: 3,
      changes: 3,
      processed: 3,
    });
    const afterCopy = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(afterCopy).toMatchObject({ phase: "verify_source" });
    expect(afterCopy?.passStartedAt).toBeGreaterThanOrEqual(before);

    // A check that found changes starts another, and that one is stamped anew.
    await t.run((ctx) =>
      ctx.db.patch(afterCopy!._id, { phase: "verify_target", changesInPass: 1, passStartedAt: 1 }),
    );
    await t.mutation(internal.functions.managedProvisioning.recordMigrationPage, {
      workspaceId,
      copied: 0,
      changes: 0,
      processed: 3,
    });
    const again = await t.run((ctx) => ctx.db.query("managedStorageMigrations").unique());
    expect(again).toMatchObject({ phase: "verify_source" });
    expect(again?.passStartedAt).toBeGreaterThanOrEqual(before);
  });
});
