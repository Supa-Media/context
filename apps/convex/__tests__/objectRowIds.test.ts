/**
 * Rows the workspace object made are named by the object's own id (`nodes.objectId`), not by their Convex `_id`:
 * how a push names them, how a mirrored change finds them (`lib/nodes/objectIds.ts`), and what an outright delete
 * leaves for the push to remove (`lib/rowWatch/`).
 *
 * Sabotage, each expected to fail a case here: drop the `objectId` branch from `objectRowOf` (the push names the
 * Convex `_id`), index by `_id` in `nodeByObjectId` (a mirrored change finds nothing), skip `goneObjectIds` in
 * `record` (a deleted object-made row is never removed from the object).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { nodeByObjectId } from "../functions/lib/nodes/objectIds";
import { flushRowChanges } from "../functions/lib/rowWatch/mutations";
import { watchDb } from "../functions/lib/rowWatch/watch";
import { objectRowOf } from "../functions/lib/workspaceObjects/rows";
import { createUser, createWorkspace, setupTest } from "./fixtures.helpers";
import { outbox, setHome, world } from "./workspaceObjectWorld.helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const OBJECT_ID = `o_${"a".repeat(32)}`;
const OTHER_OBJECT_ID = `o_${"b".repeat(32)}`;

/** Insert a live top-level file row in `workspaceId` through the watched database, flushing its outbox entry. */
async function insertWatched(
  t: ReturnType<typeof setupTest>,
  workspaceId: Id<"workspaces">,
  path: string,
  objectId?: string,
): Promise<Id<"nodes">> {
  return await t.run(async (ctx) => {
    const watch = watchDb((ctx as MutationCtx).db);
    const id = await watch.db.insert("nodes", {
      workspaceId,
      path,
      name: path,
      kind: "file",
      observedAt: Date.now(),
      ...(objectId === undefined ? {} : { objectId }),
    });
    await flushRowChanges(ctx as MutationCtx, watch.changes);
    return id;
  });
}

/** Insert a row with no watch (for the lookups, which need only the rows). */
async function insertRaw(t: ReturnType<typeof setupTest>, workspaceId: Id<"workspaces">, path: string, objectId?: string): Promise<Id<"nodes">> {
  return await t.run((ctx) =>
    ctx.db.insert("nodes", {
      workspaceId,
      path,
      name: path,
      kind: "file",
      observedAt: Date.now(),
      ...(objectId === undefined ? {} : { objectId }),
    }),
  );
}

/** Drop the outbox entries the insert left, so a case reads only the change it makes. */
async function clearOutbox(t: ReturnType<typeof setupTest>, workspaceId: Id<"workspaces">): Promise<void> {
  const entries = await outbox(t, workspaceId);
  await t.run(async (ctx) => {
    for (const entry of entries) await ctx.db.delete(entry._id);
  });
}

describe("objectRowOf names a row by the object's id", () => {
  test("a row with an objectId is named by it", () => {
    const row = objectRowOf({ _id: "k_convex_1", objectId: OBJECT_ID, path: "a.md", kind: "file", noteId: "n1" }, 5);
    expect(row).toMatchObject({ id: OBJECT_ID, path: "a.md", noteId: "n1", at: 5 });
  });

  test("a row without an objectId is named by String(_id)", () => {
    const row = objectRowOf({ _id: "k_convex_2", path: "a.md", kind: "file" }, 5);
    expect(row).toMatchObject({ id: "k_convex_2" });
  });

  test("an empty objectId falls back to _id", () => {
    const row = objectRowOf({ _id: "k_convex_3", objectId: "", path: "a.md", kind: "file" }, 5);
    expect(row).toMatchObject({ id: "k_convex_3" });
  });

  test("a gone row answers null whichever id it has", () => {
    expect(objectRowOf({ _id: "k_convex_4", objectId: OBJECT_ID, path: "a.md", kind: "file", goneAt: 1 }, 5)).toBeNull();
  });
});

describe("nodeByObjectId finds a row of one workspace by the id the object knows it by", () => {
  test("finds a row by its objectId, and a Convex-made row by String(_id)", async () => {
    const t = setupTest();
    const owner = await createUser(t, "object-row-ids@example.com");
    const workspaceId = await createWorkspace(t, owner, "object-row-ids", { kind: "shared" });
    const madeByObject = await insertRaw(t, workspaceId, "made/a.md", OBJECT_ID);
    const madeByConvex = await insertRaw(t, workspaceId, "made/b.md");

    const found = await t.run(async (ctx) => ({
      byObjectId: await nodeByObjectId(ctx.db, workspaceId, OBJECT_ID),
      byConvexId: await nodeByObjectId(ctx.db, workspaceId, String(madeByConvex)),
      objectRowByConvexId: await nodeByObjectId(ctx.db, workspaceId, String(madeByObject)),
    }));
    expect(found.byObjectId?._id).toBe(madeByObject);
    expect(found.byConvexId?._id).toBe(madeByConvex);
    // An object-made row is known by its objectId; its Convex _id is still a valid id of the same row.
    expect(found.objectRowByConvexId?._id).toBe(madeByObject);
  });

  test("returns null for an objectId of another workspace's row, and for a Convex _id of another workspace's row", async () => {
    const t = setupTest();
    const owner = await createUser(t, "object-row-ids-other@example.com");
    const here = await createWorkspace(t, owner, "object-row-ids-here", { kind: "shared" });
    const there = await createWorkspace(t, owner, "object-row-ids-there", { kind: "shared" });
    const elsewhereByObject = await insertRaw(t, there, "there/a.md", OTHER_OBJECT_ID);
    const elsewhereByConvex = await insertRaw(t, there, "there/b.md");

    const answers = await t.run(async (ctx) => ({
      objectId: await nodeByObjectId(ctx.db, here, OTHER_OBJECT_ID),
      convexId: await nodeByObjectId(ctx.db, here, String(elsewhereByConvex)),
    }));
    expect(answers.objectId).toBeNull();
    expect(answers.convexId).toBeNull();
    // The same ids do resolve in their own workspace, so the nulls are the boundary, not a missing row.
    const own = await t.run((ctx) => nodeByObjectId(ctx.db, there, OTHER_OBJECT_ID));
    expect(own?._id).toBe(elsewhereByObject);
  });

  test("returns null for garbage ids", async () => {
    const t = setupTest();
    const owner = await createUser(t, "object-row-ids-garbage@example.com");
    const workspaceId = await createWorkspace(t, owner, "object-row-ids-garbage", { kind: "shared" });
    await insertRaw(t, workspaceId, "a.md", OBJECT_ID);

    for (const garbage of ["", "not-an-id", "o_", `o_${"A".repeat(32)}`, `o_${"a".repeat(31)}`, `o_${"g".repeat(32)}`, "o_" + "a".repeat(33), " " + OBJECT_ID]) {
      expect(await t.run((ctx) => nodeByObjectId(ctx.db, workspaceId, garbage))).toBeNull();
    }
  });
});

describe("a push names object-made rows by their objectId", () => {
  test("an object-made row is pushed under its objectId, a Convex-made one under its _id", async () => {
    const { t, workspaceId } = await world();
    await setHome(t, workspaceId, "object");
    const madeByObject = await insertWatched(t, workspaceId, "plans/a.md", OBJECT_ID);
    const madeByConvex = await insertWatched(t, workspaceId, "plans/b.md");

    // The watched write left an outbox entry naming both rows.
    const entries = await outbox(t, workspaceId);
    expect(entries.length).toBe(2);

    const round = await t.query(internal.functions.workspaceObjectPush.pending, { workspaceId });
    expect(round.all).toBe(false);
    const ids = Object.fromEntries(round.rows.map((row: { path: string; id: string }) => [row.path, row.id]));
    expect(ids["plans/a.md"]).toBe(OBJECT_ID);
    expect(ids["plans/b.md"]).toBe(String(madeByConvex));
    expect(round.rows.map((row: { path: string; id: string }) => row.id)).not.toContain(String(madeByObject));
    expect(round.removed).toEqual([]);
  });
});

describe("an outright delete of an object-made row is pushed as removed under its objectId", () => {
  test("the outbox carries goneObjectIds and the push's removed names the objectId", async () => {
    const { t, workspaceId } = await world();
    await setHome(t, workspaceId, "object");
    const madeByObject = await insertWatched(t, workspaceId, "plans/a.md", OBJECT_ID);
    // Drain nothing: the insert's entries are not the subject here, so take them out of the way first.
    await clearOutbox(t, workspaceId);

    await t.run(async (ctx) => {
      const watch = watchDb((ctx as MutationCtx).db);
      await watch.db.delete(madeByObject);
      await flushRowChanges(ctx as MutationCtx, watch.changes);
    });

    const entries = await outbox(t, workspaceId);
    expect(entries.length).toBe(1);
    expect(entries[0].goneObjectIds).toEqual([OBJECT_ID]);

    const round = await t.query(internal.functions.workspaceObjectPush.pending, { workspaceId });
    expect(round.removed).toContain(OBJECT_ID);
    expect(round.rows).toEqual([]);
  });

  test("a Convex-made row deleted outright gives no goneObjectIds", async () => {
    const { t, workspaceId } = await world();
    await setHome(t, workspaceId, "object");
    const madeByConvex = await insertWatched(t, workspaceId, "plans/b.md");
    await clearOutbox(t, workspaceId);

    await t.run(async (ctx) => {
      const watch = watchDb((ctx as MutationCtx).db);
      await watch.db.delete(madeByConvex);
      await flushRowChanges(ctx as MutationCtx, watch.changes);
    });

    const entries = await outbox(t, workspaceId);
    expect(entries.length).toBe(1);
    expect(entries[0].goneObjectIds).toBeUndefined();

    const round = await t.query(internal.functions.workspaceObjectPush.pending, { workspaceId });
    expect(round.removed).not.toContain(OBJECT_ID);
  });
});

describe("a gone object-made row is removed under its objectId", () => {
  test("setting goneAt pushes the row as removed by objectId", async () => {
    const { t, workspaceId } = await world();
    await setHome(t, workspaceId, "object");
    const madeByObject = await insertWatched(t, workspaceId, "plans/a.md", OBJECT_ID);

    await t.run(async (ctx) => {
      const watch = watchDb((ctx as MutationCtx).db);
      await watch.db.patch(madeByObject, { goneAt: Date.now() });
      await flushRowChanges(ctx as MutationCtx, watch.changes);
    });

    const round = await t.query(internal.functions.workspaceObjectPush.pending, { workspaceId });
    expect(round.removed).toContain(OBJECT_ID);
    expect(round.removed).not.toContain(String(madeByObject));
    expect(round.rows.map((row: { path: string; id: string }) => row.id)).not.toContain(OBJECT_ID);
  });
});
