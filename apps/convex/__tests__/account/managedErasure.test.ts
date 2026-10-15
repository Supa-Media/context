/**
 * Deleting an account erases the storage we ran for the workspaces it solely
 * owned (decided by the owner, 2026-10-15), and nothing else.
 *
 * What has to hold: a sole owner's managed bucket is emptied page by page,
 * deleted, and its scoped token revoked; a co-owned workspace, a customer's
 * own bucket, and another tenant's bucket are never touched; a provider
 * failure keeps the job (and its bucket and token references) and a retry
 * finishes it; a row naming a bucket that is not its workspace's, or a token
 * that is not that bucket's, deletes nothing of it; and only a signed-in,
 * email-proven caller can start any of this.
 *
 * Sabotage, each confirmed to fail a case here: drop the bucket-name check in
 * `runManagedErasure` (the foreign-bucket case), drop the token-name check in
 * `revokeBucketToken` (the foreign-token case), queue on any binding rather
 * than the derived name (the own-bucket case), and record "done" without
 * `bucketDeleted` (the provider-failure case).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  addMember,
  asPhoneOnly,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedAppSecret,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { scopedTokenName } from "../../functions/lib/cloudflare";
import {
  MANAGED_R2_ACCOUNT_ID_ENV_VAR,
  MANAGED_R2_API_TOKEN_SECRET,
  managedBucketName,
} from "../../functions/lib/managedStorage";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

/** A Cloudflare account in memory: buckets of keys, tokens by id. */
class FakeCloudflare {
  buckets = new Map<string, Set<string>>();
  tokens = new Map<string, string>();
  calls: string[] = [];
  /** Answer the next N calls with a 503. */
  failNext = 0;
  /** Answer every call with a 503. */
  down = false;
  /** Answer calls to the bucket (not the token) with a 503. */
  bucketDown = false;

  addBucket(name: string, keys: number) {
    this.buckets.set(name, new Set(Array.from({ length: keys }, (_, i) => `notes/${i}.md`)));
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.href.slice(BASE.length).split("?")[0];
    this.calls.push(`${method} ${path}`);
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }));
    const missing = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10006, message: "not found" }] }), { status: 404 });
    if (!url.href.startsWith(BASE)) return missing();
    if (this.down || this.failNext > 0 || (this.bucketDown && path.startsWith("/r2/"))) {
      this.failNext = Math.max(0, this.failNext - 1);
      return new Response(JSON.stringify({ success: false, errors: [] }), { status: 503 });
    }
    const object = /^\/r2\/buckets\/([^/]+)\/objects\/(.+)$/.exec(path);
    const objects = /^\/r2\/buckets\/([^/]+)\/objects$/.exec(path);
    const bucket = /^\/r2\/buckets\/([^/]+)$/.exec(path);
    const token = /^\/tokens\/([^/]+)$/.exec(path);
    if (objects && method === "GET") {
      const keys = this.buckets.get(decodeURIComponent(objects[1]));
      if (!keys) return missing();
      const perPage = Number(url.searchParams.get("per_page") ?? "1000");
      return ok([...keys].slice(0, perPage).map((key) => ({ key })));
    }
    if (object && method === "DELETE") {
      const keys = this.buckets.get(decodeURIComponent(object[1]));
      const key = object[2].split("/").map(decodeURIComponent).join("/");
      if (!keys?.delete(key)) return missing();
      return ok(null);
    }
    if (bucket && method === "DELETE") {
      const name = decodeURIComponent(bucket[1]);
      const keys = this.buckets.get(name);
      if (!keys) return missing();
      if (keys.size > 0) return new Response(JSON.stringify({ success: false, errors: [{ code: 10008 }] }), { status: 409 });
      this.buckets.delete(name);
      return ok(null);
    }
    if (token && method === "GET") {
      const name = this.tokens.get(decodeURIComponent(token[1]));
      return name === undefined ? missing() : ok({ id: token[1], name });
    }
    if (token && method === "DELETE") {
      if (!this.tokens.delete(decodeURIComponent(token[1]))) return missing();
      return ok(null);
    }
    return missing();
  };
}

let cloudflare: FakeCloudflare;

beforeEach(() => {
  vi.useFakeTimers();
  cloudflare = new FakeCloudflare();
  vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, ACCOUNT);
  vi.stubGlobal("fetch", cloudflare.fetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A sole owner on storage we run: a bucket of `keys` notes and its token. */
async function managedOwner(t: TestConvex, slug: string, keys: number, email = `${slug}@example.test`) {
  const owner = await createUser(t, email);
  const workspaceId = await createWorkspace(t, owner, slug);
  const bucket = managedBucketName(workspaceId);
  const tokenId = `token-${slug}`;
  await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket, accessKeyId: tokenId });
  cloudflare.addBucket(bucket, keys);
  cloudflare.tokens.set(tokenId, scopedTokenName(bucket));
  return { owner, workspaceId, bucket, tokenId };
}

async function erasures(t: TestConvex) {
  return await t.run((ctx) => ctx.db.query("managedErasures").collect());
}

/** Run every due job to the end, backoffs included. */
async function finishAll(t: TestConvex) {
  await t.finishAllScheduledFunctions(vi.runAllTimers, 500);
}

/** Run exactly the jobs due now. */
async function runDueOnce(t: TestConvex) {
  vi.advanceTimersByTime(1);
  await t.finishInProgressScheduledFunctions();
}

describe("managed erasure on account deletion", () => {
  test("a sole owner's managed bucket is emptied across pages, deleted, and its token revoked", async () => {
    const t = setupTest();
    await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, "fake-operator-token");
    const { owner, workspaceId, bucket, tokenId } = await managedOwner(t, "erase-me", 2_345);

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    // Queued in the deleting transaction, before the binding was gone.
    const [queued] = await erasures(t);
    expect(queued).toMatchObject({ workspaceId, bucket, tokenId, status: "pending", bucketDeleted: false, token: "pending" });
    expect(await t.run((ctx) => ctx.db.query("storageBindings").collect())).toEqual([]);

    await finishAll(t);
    expect(cloudflare.buckets.has(bucket)).toBe(false);
    expect(cloudflare.tokens.has(tokenId)).toBe(false);
    const [done] = await erasures(t);
    expect(done).toMatchObject({ status: "done", bucketDeleted: true, token: "revoked", objectsDeleted: 2_345 });
    // More than one page: three listings of 1,000 or fewer, then the empty one.
    expect(cloudflare.calls.filter((call) => call === `GET /r2/buckets/${bucket}/objects`).length).toBeGreaterThanOrEqual(4);
    // The token went before any object did.
    expect(cloudflare.calls.indexOf(`DELETE /tokens/${tokenId}`)).toBeLessThan(
      cloudflare.calls.findIndex((call) => call.startsWith(`DELETE /r2/buckets/${bucket}/objects/`)),
    );
  });

  test("a provider failure keeps the job and its references, and a retry finishes it", async () => {
    const t = setupTest();
    await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, "fake-operator-token");
    const { owner, bucket, tokenId } = await managedOwner(t, "flaky", 30);
    cloudflare.down = true;

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    await runDueOnce(t);
    const [failed] = await erasures(t);
    expect(failed).toMatchObject({
      status: "pending",
      bucket,
      tokenId,
      bucketDeleted: false,
      token: "pending",
      attempts: 1,
      lastError: "CLOUDFLARE_UNAVAILABLE",
    });
    expect(failed.leaseUntil).toBeUndefined();
    expect(failed.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(cloudflare.buckets.get(bucket)?.size).toBe(30);

    // Still down at the first retry: backoff grows, nothing is lost.
    vi.advanceTimersByTime(60_000);
    await t.finishInProgressScheduledFunctions();
    expect((await erasures(t))[0]).toMatchObject({ status: "pending", attempts: 2 });

    cloudflare.down = false;
    await finishAll(t);
    expect((await erasures(t))[0]).toMatchObject({ status: "done", bucketDeleted: true, token: "revoked" });
    expect(cloudflare.buckets.has(bucket)).toBe(false);
  });

  test("a revoked token alone never finishes the job: the notes must be gone too", async () => {
    const t = setupTest();
    await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, "fake-operator-token");
    const { owner, bucket, tokenId } = await managedOwner(t, "half-done", 7);
    cloudflare.bucketDown = true;
    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    await runDueOnce(t);
    expect(cloudflare.tokens.has(tokenId)).toBe(false);
    expect((await erasures(t))[0]).toMatchObject({ status: "pending", token: "revoked", bucketDeleted: false, bucket });

    cloudflare.bucketDown = false;
    await finishAll(t);
    expect((await erasures(t))[0]).toMatchObject({ status: "done", bucketDeleted: true, objectsDeleted: 7 });
    expect(cloudflare.buckets.has(bucket)).toBe(false);
  });

  test("a run that died holding the row is picked up by the sweep once its lease lapses", async () => {
    const t = setupTest();
    await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, "fake-operator-token");
    const { owner, bucket } = await managedOwner(t, "stalled", 5);
    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    // Simulate a run that claimed the row and never came back.
    const [row] = await erasures(t);
    await t.run((ctx) => ctx.db.patch(row._id, { leaseUntil: Date.now() + 60_000 }));
    await runDueOnce(t);
    expect((await erasures(t))[0].status).toBe("pending");
    expect(await t.mutation(internal.functions.managedErasure.sweepManagedErasures, {})).toBe(0);

    vi.advanceTimersByTime(61_000);
    expect(await t.mutation(internal.functions.managedErasure.sweepManagedErasures, {})).toBe(1);
    await finishAll(t);
    expect((await erasures(t))[0].status).toBe("done");
    expect(cloudflare.buckets.has(bucket)).toBe(false);
  });

  test("an unconfigured deployment keeps the job pending rather than dropping it", async () => {
    const t = setupTest();
    const { owner, bucket } = await managedOwner(t, "no-secret", 3);
    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    await runDueOnce(t);
    expect((await erasures(t))[0]).toMatchObject({ status: "pending", lastError: "NOT_CONFIGURED", attempts: 1 });
    expect(cloudflare.calls).toEqual([]);
    expect(cloudflare.buckets.get(bucket)?.size).toBe(3);
  });

  test("a co-owned workspace, a customer's own bucket and another tenant are never touched", async () => {
    const t = setupTest();
    await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, "fake-operator-token");
    const leaving = await managedOwner(t, "leaving", 4);
    const bystander = await managedOwner(t, "bystander", 4);

    // A shared workspace on storage we run, with a second owner.
    const coOwned = await createWorkspace(t, leaving.owner, "co-owned", { kind: "shared" });
    await addMember(t, coOwned, bystander.owner, "owner", leaving.owner);
    const coOwnedBucket = managedBucketName(coOwned);
    await seedStorageBinding(t, { workspaceId: coOwned, boundBy: leaving.owner, bucket: coOwnedBucket, accessKeyId: "token-co" });
    cloudflare.addBucket(coOwnedBucket, 4);
    cloudflare.tokens.set("token-co", scopedTokenName(coOwnedBucket));

    // A shared workspace on the person's own bucket: forgotten, not reached.
    const own = await createWorkspace(t, leaving.owner, "own-bucket", { kind: "shared" });
    await seedStorageBinding(t, { workspaceId: own, boundBy: leaving.owner, bucket: "their-own-bucket", accessKeyId: "their-key" });
    cloudflare.addBucket("their-own-bucket", 4);

    await asUser(t, leaving.owner).mutation(api.functions.account.deleteAccount, {});
    await finishAll(t);

    expect(cloudflare.buckets.has(leaving.bucket)).toBe(false);
    expect(cloudflare.buckets.get(coOwnedBucket)?.size).toBe(4);
    expect(cloudflare.tokens.get("token-co")).toBe(scopedTokenName(coOwnedBucket));
    expect(cloudflare.buckets.get("their-own-bucket")?.size).toBe(4);
    expect(cloudflare.buckets.get(bystander.bucket)?.size).toBe(4);
    expect(cloudflare.tokens.has(bystander.tokenId)).toBe(true);
    expect((await erasures(t)).map((row) => row.bucket)).toEqual([leaving.bucket]);
    expect(cloudflare.calls.every((call) => call.includes(leaving.bucket) || call.includes(leaving.tokenId))).toBe(true);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(coOwned)).not.toBeNull();
      expect(await ctx.db.get(bystander.workspaceId)).not.toBeNull();
    });
  });

  test("a row naming another workspace's bucket is refused and deletes nothing", async () => {
    const t = setupTest();
    await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, "fake-operator-token");
    const victim = await managedOwner(t, "victim", 4);
    const other = await createUser(t, "other@example.test");
    const otherWs = await createWorkspace(t, other, "other-ws");
    const erasureId = await t.run((ctx) =>
      ctx.db.insert("managedErasures", {
        workspaceId: otherWs,
        bucket: victim.bucket,
        tokenId: victim.tokenId,
        status: "pending",
        bucketDeleted: false,
        token: "pending",
        objectsDeleted: 0,
        attempts: 0,
        nextAttemptAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.action(internal.functions.managedErasure.runManagedErasure, { erasureId });
    expect(await t.run((ctx) => ctx.db.get(erasureId))).toMatchObject({ status: "refused", lastError: "FOREIGN_BUCKET" });
    expect(cloudflare.calls).toEqual([]);
    expect(cloudflare.buckets.get(victim.bucket)?.size).toBe(4);
  });

  test("a token id that is not the bucket's token is left standing", async () => {
    const t = setupTest();
    await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, "fake-operator-token");
    const { owner, bucket } = await managedOwner(t, "odd-token", 2);
    // The binding names the operator's own token by mistake.
    await t.run(async (ctx) => {
      const binding = (await ctx.db.query("storageBindings").collect())[0];
      await ctx.db.patch(binding._id, { accessKeyId: "operator-token" });
    });
    cloudflare.tokens.set("operator-token", "Context operator");

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    await finishAll(t);
    expect(cloudflare.tokens.get("operator-token")).toBe("Context operator");
    expect(cloudflare.buckets.has(bucket)).toBe(false);
    expect((await erasures(t))[0]).toMatchObject({ status: "done", token: "not_for_bucket", lastError: "TOKEN_NOT_FOR_BUCKET" });
  });

  test("an already-erased bucket and token finish the job rather than failing it", async () => {
    const t = setupTest();
    await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, "fake-operator-token");
    const { owner, bucket, tokenId } = await managedOwner(t, "gone-already", 2);
    cloudflare.buckets.delete(bucket);
    cloudflare.tokens.delete(tokenId);
    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    await finishAll(t);
    expect((await erasures(t))[0]).toMatchObject({ status: "done", bucketDeleted: true, token: "absent" });
  });

  test("a move into storage we run queues its target bucket too", async () => {
    const t = setupTest();
    await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, "fake-operator-token");
    const owner = await createUser(t, "mover@example.test");
    const workspaceId = await createWorkspace(t, owner, "mid-move");
    await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: "their-source" });
    const bindingId = await t.run(async (ctx) => (await ctx.db.query("storageBindings").collect())[0]._id);
    const target = managedBucketName(workspaceId);
    cloudflare.addBucket(target, 3);
    cloudflare.tokens.set("token-target", scopedTokenName(target));
    cloudflare.addBucket("their-source", 3);
    await t.run((ctx) =>
      ctx.db.insert("managedStorageMigrations", {
        workspaceId,
        sourceBindingId: bindingId,
        startedBy: owner,
        direction: "to_managed",
        targetEndpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
        targetBucket: target,
        targetAccessKeyId: "token-target",
        encryptedTargetSecretAccessKey: "sealed-fake",
        status: "copying",
        phase: "copy",
        objectsCopied: 0,
        changesInPass: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never),
    );
    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    await finishAll(t);
    expect(cloudflare.buckets.has(target)).toBe(false);
    expect(cloudflare.tokens.has("token-target")).toBe(false);
    expect(cloudflare.buckets.get("their-source")?.size).toBe(3);
  });

  test("nobody signed out, and nobody without email proof, can start an erasure", async () => {
    const t = setupTest();
    const { owner, bucket } = await managedOwner(t, "guarded", 2);
    const anonymous = await captureError(() => t.mutation(api.functions.account.deleteAccount, {}));
    expect(anonymous).toBeTruthy();
    const phone = await asPhoneOnly(t, owner);
    const phoneOnly = await captureError(() => phone.view.mutation(api.functions.account.deleteAccount, {}));
    expect(errorCode(phoneOnly)).toBe("EMAIL_PROOF_REQUIRED");
    expect(await erasures(t)).toEqual([]);
    expect(cloudflare.buckets.get(bucket)?.size).toBe(2);
  });
});

describe("deletionPreview", () => {
  test("names exactly the workspaces deletion removes, and which are erased", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await managedOwner(t, "previewer", 1);
    const friend = await createUser(t, "friend@example.test");
    const own = await createWorkspace(t, owner, "own-store", { kind: "shared" });
    await seedStorageBinding(t, { workspaceId: own, boundBy: owner, bucket: "their-bucket" });
    await addMember(t, own, friend, "editor", owner);
    const coOwned = await createWorkspace(t, owner, "co-run", { kind: "shared" });
    await addMember(t, coOwned, friend, "owner", owner);
    const theirs = await createWorkspace(t, friend, "friends-own", { kind: "shared" });
    await addMember(t, theirs, owner, "editor", friend);

    const preview = await asUser(t, owner).query(api.functions.accountDeletion.deletionPreview, {});
    expect(preview?.map((row) => [row.slug, row.managed, row.others]).sort()).toEqual(
      [
        ["own-store", false, 1],
        ["previewer", true, 0],
      ].sort(),
    );
    expect(preview?.some((row) => row.workspaceId === workspaceId)).toBe(true);
    expect(await t.query(api.functions.accountDeletion.deletionPreview, {})).toBeNull();
  });
});
