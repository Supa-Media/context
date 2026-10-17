/**
 * Dropbox is gone from the product, and its leftover rows are emptied by
 * `internal.functions.dropboxRemoval.purge`.
 *
 * What has to hold:
 *  - a legacy Dropbox binding reads as no storage, before and after the purge,
 *    and nothing throws on it (the console, the gateway path);
 *  - the purge deletes Dropbox bindings and their envelopes, and every parked
 *    Dropbox connect attempt, and writes the disconnect audit with a reason;
 *  - it leaves other providers' bindings, every tree row, and anything in a
 *    bucket alone;
 *  - a second run finds nothing and changes nothing.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isServedProvider } from "../functions/lib/storage/shapes";
import { asUser, bindFakeStorage, createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";

const LEGACY_ENVELOPE = "v2:current:FAKE:LEGACY-REFRESH-TOKEN";

/** A workspace bound to R2, reshaped into a legacy Dropbox row written directly. */
async function legacyDropboxWorkspace(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug);
  await bindFakeStorage(t, owner, workspaceId);
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    await ctx.db.patch(row!._id, {
      provider: "dropbox",
      encryptedRefreshToken: LEGACY_ENVELOPE,
      encryptedAccessToken: "v2:current:FAKE:LEGACY-ACCESS-TOKEN",
      accessTokenExpiresAt: Date.now() + 60_000,
      dropboxAccountId: "dbid:FAKE-ACCOUNT",
      endpoint: undefined,
      region: undefined,
      bucket: undefined,
      accessKeyId: undefined,
      encryptedSecretAccessKey: undefined,
    });
  });
  return { owner, workspaceId };
}

async function seedAttempt(t: TestConvex, workspaceId: Id<"workspaces">, owner: Id<"users">, state: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("dropboxConnectAttempts", {
      hashedState: state,
      encryptedVerifier: "v2:current:FAKE:LEGACY-VERIFIER",
      workspaceId,
      startedBy: owner,
      redirectUri: "https://console.example/callback",
      expiresAt: Date.now() + 600_000,
      createdAt: Date.now(),
    });
  });
}

async function seedTree(t: TestConvex, workspaceId: Id<"workspaces">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("nodes", {
      workspaceId,
      path: "notes/keep.md",
      name: "keep.md",
      kind: "file",
      observedAt: 1,
    });
    await ctx.db.insert("nodeFactState", { workspaceId, ready: true, seq: 1 });
  });
}

async function treeRowCount(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run(async (ctx) => {
    const nodes = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const facts = await ctx.db
      .query("nodeFactState")
      .filter((q) => q.eq(q.field("workspaceId"), workspaceId))
      .collect();
    return nodes.length + facts.length;
  });
}

describe("a legacy Dropbox binding before the purge", () => {
  test("reads as no storage in the console, and nothing throws", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await legacyDropboxWorkspace(t, "legacy-read");

    const binding = await asUser(t, owner).query(api.functions.storage.getStorageBinding, { workspaceId });
    expect(binding).toBeNull();
  });

  test("is not served to the gateway: no binding, and no decrypt is attempted", async () => {
    const t = setupTest();
    const { workspaceId } = await legacyDropboxWorkspace(t, "legacy-gateway");

    const credential = await t.action(internal.functions.storage.getBindingForGateway, { workspaceId });
    expect(credential).toBeNull();
  });
});

describe("rebinding over a legacy row", () => {
  test("replaces the row, so none of its old fields survive the new binding", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await legacyDropboxWorkspace(t, "legacy-rebind");

    await bindFakeStorage(t, owner, workspaceId, { bucket: "rebound-bucket" });

    const rows = await t.run((ctx) => ctx.db.query("storageBindings").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "r2", bucket: "rebound-bucket" });
    expect(rows[0]!.encryptedRefreshToken).toBeUndefined();
    expect(rows[0]!.encryptedAccessToken).toBeUndefined();
    expect(rows[0]!.dropboxAccountId).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain(LEGACY_ENVELOPE);
  });
});

describe("dropboxRemoval.purge", () => {
  test("deletes Dropbox bindings with their envelopes, and every Dropbox connect attempt", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await legacyDropboxWorkspace(t, "purge-binding");
    await seedAttempt(t, workspaceId, owner, "hashed-state-one");
    await seedAttempt(t, workspaceId, owner, "hashed-state-two");

    const result = await t.mutation(internal.functions.dropboxRemoval.purge, {});

    expect(result).toEqual({ bindingsRemoved: 1, bindingsSkipped: 0, attemptsRemoved: 2, more: false });
    const rows = await t.run((ctx) => ctx.db.query("storageBindings").collect());
    expect(rows).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("dropboxConnectAttempts").collect())).toHaveLength(0);
    // The envelope is gone with the row, not left behind on a sibling field.
    expect(JSON.stringify(rows)).not.toContain(LEGACY_ENVELOPE);
  });

  test("leaves bindings of every served provider untouched", async () => {
    const t = setupTest();
    const owner = await createUser(t, "other-provider@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "other-provider");
    await bindFakeStorage(t, owner, workspaceId);
    const before = await t.run((ctx) => ctx.db.query("storageBindings").collect());

    const result = await t.mutation(internal.functions.dropboxRemoval.purge, {});

    expect(result.bindingsRemoved).toBe(0);
    const after = await t.run((ctx) => ctx.db.query("storageBindings").collect());
    expect(after).toEqual(before);
  });

  test("never touches tree rows, and writes the disconnect audit with a reason", async () => {
    const t = setupTest();
    const { workspaceId } = await legacyDropboxWorkspace(t, "purge-tree");
    await seedTree(t, workspaceId);
    const treeBefore = await treeRowCount(t, workspaceId);
    expect(treeBefore).toBeGreaterThan(0);

    await t.mutation(internal.functions.dropboxRemoval.purge, {});

    expect(await treeRowCount(t, workspaceId)).toBe(treeBefore);
    const audits = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    const disconnects = audits.filter((row) => row.action === "storage.disconnected");
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]!.details).toMatchObject({ provider: "dropbox", reason: "dropbox-removed" });
    expect(disconnects[0]!.actorUserId).toBeUndefined();
    expect(JSON.stringify(audits)).not.toContain(LEGACY_ENVELOPE);
  });

  test("is idempotent: a second run finds nothing and changes nothing", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await legacyDropboxWorkspace(t, "purge-twice");
    await seedAttempt(t, workspaceId, owner, "hashed-state-once");
    await t.mutation(internal.functions.dropboxRemoval.purge, {});
    const auditsAfterFirst = await t.run((ctx) => ctx.db.query("auditEvents").collect());

    const second = await t.mutation(internal.functions.dropboxRemoval.purge, {});

    expect(second).toEqual({ bindingsRemoved: 0, bindingsSkipped: 0, attemptsRemoved: 0, more: false });
    expect(await t.run((ctx) => ctx.db.query("auditEvents").collect())).toHaveLength(auditsAfterFirst.length);
  });

  test("is bounded: a run past its limit reports more, and the next run finishes", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await legacyDropboxWorkspace(t, "purge-bounded");
    await seedAttempt(t, workspaceId, owner, "bounded-one");
    await seedAttempt(t, workspaceId, owner, "bounded-two");
    await seedAttempt(t, workspaceId, owner, "bounded-three");

    const first = await t.mutation(internal.functions.dropboxRemoval.purge, { limit: 2 });
    expect(first).toMatchObject({ attemptsRemoved: 2, bindingsRemoved: 1, more: true });

    const second = await t.mutation(internal.functions.dropboxRemoval.purge, { limit: 2 });
    expect(second).toMatchObject({ attemptsRemoved: 1, bindingsRemoved: 0, more: false });
    expect(await t.run((ctx) => ctx.db.query("dropboxConnectAttempts").collect())).toHaveLength(0);
  });
});

describe("served providers", () => {
  test("only the four bucket providers are served; a legacy dropbox row is not", () => {
    expect(isServedProvider("r2")).toBe(true);
    expect(isServedProvider("s3")).toBe(true);
    expect(isServedProvider("b2")).toBe(true);
    expect(isServedProvider("s3-compatible")).toBe(true);
    expect(isServedProvider("dropbox")).toBe(false);
    expect(isServedProvider("")).toBe(false);
  });
});

describe("dropboxRemoval.count", () => {
  test("reports the Dropbox bindings and attempts that remain, and zero after the purge", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await legacyDropboxWorkspace(t, "count-remain");
    await seedAttempt(t, workspaceId, owner, "count-state");

    expect(await t.query(internal.functions.dropboxRemoval.count, {})).toEqual({
      dropboxBindings: 1,
      dropboxAttempts: 1,
      truncated: false,
    });

    await t.mutation(internal.functions.dropboxRemoval.purge, {});

    expect(await t.query(internal.functions.dropboxRemoval.count, {})).toEqual({
      dropboxBindings: 0,
      dropboxAttempts: 0,
      truncated: false,
    });
  });
});
