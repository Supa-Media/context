/**
 * A workspace's first binding starts it keyed (`lib/noteIds/born.ts`), a
 * managed bucket or one its owner brings, so its notes never sit on path keys.
 *
 * Sabotage: drop the `keyIfBornEmpty` call from `storage.applyBinding` and the
 * first two cases fail (no copy row, never keyed).
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { copyRowOf } from "../../functions/lib/noteIds/state";
import { tester, user, type T } from "./noteIds.helpers";

async function newWorkspace(t: T): Promise<{ ws: Id<"workspaces">; owner: Id<"users"> }> {
  const owner = await user(t, "owner@example.test");
  const ws = await t.run(async (ctx) => {
    const now = Date.now();
    const ws = await ctx.db.insert("workspaces", {
      slug: "fresh",
      displayName: "Fresh",
      createdBy: owner,
      kind: "personal",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: owner, role: "owner", joinedAt: now });
    return ws;
  });
  return { ws, owner };
}

async function bind(t: T, ws: Id<"workspaces">, owner: Id<"users">, bucket: string): Promise<void> {
  await t.mutation(internal.functions.storage.applyBinding, {
    actorUserId: owner,
    workspaceId: ws,
    provider: "r2",
    endpoint: "https://storage.example.test",
    region: "auto",
    bucket,
    accessKeyId: "fake",
    encryptedSecretAccessKey: "fake",
  });
}

describe("a new workspace", () => {
  test("bound to its managed bucket is keyed at once, with nothing left to flip", async () => {
    const t = tester();
    const { ws, owner } = await newWorkspace(t);
    await bind(t, ws, owner, managedBucketName(ws));
    expect((await t.run((ctx) => copyRowOf(ctx.db, ws)))?.keyedAt).toEqual(expect.any(Number));
    expect(await t.run((ctx) => copyRowOf(ctx.db, ws))).toMatchObject({
      status: "done",
      keyedAt: expect.any(Number),
      keyedDoneAt: expect.any(Number),
    });
    // Its tree serves at once: a keyed workspace is never swept, so nothing else would make it ready.
    const tree = await t.run(async (ctx) => (await ctx.db.query("nodeTrees").collect()).find((tree) => tree.workspaceId === ws) ?? null);
    expect(tree?.status).toBe("ready");
    // And it builds its paths from parents from the start: there is nothing for the flip to walk.
    expect(tree?.paths).toBe("built");
  });

  test("bound to a bucket its owner brings is keyed at once too: files already there are not picked up", async () => {
    const t = tester();
    const { ws, owner } = await newWorkspace(t);
    await bind(t, ws, owner, "owners-own-bucket");
    expect((await t.run((ctx) => copyRowOf(ctx.db, ws)))?.keyedAt).toEqual(expect.any(Number));
  });

  test("that already has tree rows is not marked keyed: they may be unkeyed", async () => {
    const t = tester();
    const { ws, owner } = await newWorkspace(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("nodes", { workspaceId: ws, path: "inbox", name: "inbox", kind: "folder", observedAt: 1 });
    });
    await bind(t, ws, owner, managedBucketName(ws));
    expect((await t.run((ctx) => copyRowOf(ctx.db, ws)))?.keyedAt).toBeUndefined();
  });
});
