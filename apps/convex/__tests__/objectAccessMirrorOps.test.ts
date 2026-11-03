/**
 * Convex written behind the object's other access ops (`functions/objectAccessMirror.ts` `pending`, `dropGrantee`,
 * `narrowBases`): pending access for a path with no row, an account's grants taken out, and a move's narrowing.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { T, PLAN, GROUP_VIEW, world, rowOf, rowIdOf, stateOf, grantsOn, auditOf, outbox, seedState, objectHome } from "./objectAccessMirror.helpers";

describe("objectAccessMirror.pending", () => {
  const NEW_PATH = "1-projects/new.md";

  /** A pending record the object would send for `NEW_PATH` (`accessWrite.js` `writePending`). */
  type PendingRecord = {
    path: string;
    kind: "file" | "folder";
    base: "private" | "team" | null;
    baseVersion: number;
    version: number;
    narrowing?: boolean;
    actorUserId?: string;
    clientId?: string;
  };
  function pendingRecordFor(extra: Partial<PendingRecord> = {}): PendingRecord {
    return { path: NEW_PATH, kind: "file", base: "private", baseVersion: 3, version: 4, ...extra };
  }

  test("no row at the path: base private answers applied, waits as a pending entry, and the version is the object's", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.pending, {
      workspaceId: w.ws,
      objectAt: 50,
      record: pendingRecordFor(),
    });
    expect(answer).toEqual({ applied: true });
    const state = await stateOf(w.t, w.ws);
    expect(state?.pending).toHaveLength(1);
    expect(state?.pending?.[0]).toMatchObject({ path: NEW_PATH, kind: "file", base: "private" });
    expect(state?.version).toBe(4);
  });

  test("then base null (inherit) for the same path drops the waiting entry", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    await w.t.mutation(internal.functions.objectAccessMirror.pending, {
      workspaceId: w.ws,
      objectAt: 50,
      record: pendingRecordFor(),
    });
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.pending, {
      workspaceId: w.ws,
      objectAt: 51,
      record: pendingRecordFor({ base: null, baseVersion: 4, version: 5 }),
    });
    expect(answer).toEqual({ applied: true });
    const pending = (await stateOf(w.t, w.ws))?.pending ?? [];
    expect(pending.find((entry) => entry.path === NEW_PATH)).toBeUndefined();
  });

  test("a live row already at the path takes the base as its own, and no pending entry is added", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.pending, {
      workspaceId: w.ws,
      objectAt: 52,
      record: pendingRecordFor({ path: PLAN }),
    });
    expect(answer).toEqual({ applied: true });
    expect((await rowOf(w.t, w.ws, PLAN))?.access?.base).toBe("private");
    expect((await stateOf(w.t, w.ws))?.pending ?? []).toEqual([]);
  });

  test("a version the object did not see: the version is one above the object's, and an access push is queued", async () => {
    const w = await world();
    // Convex is at 4 and the object decided from 3: Convex took its own access change in between.
    await seedState(w.t, w.ws, 4);
    await objectHome(w.t, w.ws);
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.pending, {
      workspaceId: w.ws,
      objectAt: 53,
      record: pendingRecordFor({ baseVersion: 3, version: 4 }),
    });
    expect(answer).toEqual({ applied: true });
    expect((await stateOf(w.t, w.ws))?.version).toBe(5);
    expect(await outbox(w.t)).toContainEqual(expect.objectContaining({ workspaceId: w.ws, access: true, nodeIds: [] }));
  });

  test("a full pending list (100 live entries) refuses a new path with pending_full and writes nothing", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const state = await stateOf(w.t, w.ws);
    const now = Date.now();
    const full = Array.from({ length: 100 }, (_, i) => ({ path: `1-projects/filler-${i}.md`, kind: "file" as const, base: "private" as const, at: now }));
    await w.t.run((ctx) => ctx.db.patch(state!._id, { pending: full }));
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.pending, {
      workspaceId: w.ws,
      objectAt: 54,
      record: pendingRecordFor(),
    });
    expect(answer).toEqual({ applied: false, reason: "pending_full" });
    const after = (await stateOf(w.t, w.ws))?.pending ?? [];
    expect(after).toHaveLength(100);
    expect(after.find((entry) => entry.path === NEW_PATH)).toBeUndefined();
  });
});

describe("objectAccessMirror.dropGrantee", () => {
  /** A second account, for a grant that must survive the drop. */
  async function addUser(t: T, email: string): Promise<Id<"users">> {
    return await t.run((ctx) => ctx.db.insert("users", { email, emailVerificationTime: Date.now() } as never));
  }

  /** A user grant on the row at `nodeId`, as the owner made it. */
  async function userGrant(t: T, ws: Id<"workspaces">, nodeId: Id<"nodes">, userId: Id<"users">, role: "view" | "edit", owner: Id<"users">) {
    await t.run((ctx) =>
      ctx.db.insert("nodeAccess", {
        workspaceId: ws,
        nodeId,
        granteeKind: "user",
        granteeUserId: userId,
        role,
        grantedBy: owner,
        at: 1,
        source: "owner",
      }),
    );
  }

  /** Every grant in `ws` held by `userId`, by the index the removal reads. */
  async function grantsOfUser(t: T, ws: Id<"workspaces">, userId: Id<"users">) {
    return await t.run(async (ctx) =>
      await ctx.db
        .query("nodeAccess")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", ws).eq("granteeUserId", userId))
        .collect(),
    );
  }

  const dropRecord = (userId: string, actorUserId: string, extra: { baseVersion?: number; version?: number } = {}) => ({
    kind: "user" as const,
    id: userId,
    actorUserId,
    baseVersion: extra.baseVersion ?? 3,
    version: extra.version ?? 4,
  });

  test("a user's grants in the workspace are dropped on every row, another user's grant stays, and one access.list audit row is written", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const mia = await addUser(w.t, "mia@example.test");
    const dan = await addUser(w.t, "dan@example.test");
    await userGrant(w.t, w.ws, (await rowOf(w.t, w.ws, PLAN))!._id, mia, "edit", w.owner);
    await userGrant(w.t, w.ws, (await rowOf(w.t, w.ws, GROUP_VIEW))!._id, mia, "view", w.owner);
    await userGrant(w.t, w.ws, (await rowOf(w.t, w.ws, PLAN))!._id, dan, "view", w.owner);
    expect(await grantsOfUser(w.t, w.ws, mia)).toHaveLength(2);

    const answer = await w.t.mutation(internal.functions.objectAccessMirror.dropGrantee, {
      workspaceId: w.ws,
      objectAt: 60,
      record: dropRecord(mia, w.owner),
    });
    expect(answer).toEqual({ applied: true });

    expect(await grantsOfUser(w.t, w.ws, mia)).toEqual([]);
    const planGrants = await grantsOn(w.t, w.ws, PLAN);
    expect(planGrants).toHaveLength(1);
    expect(planGrants[0]).toMatchObject({ granteeKind: "user", granteeUserId: dan, role: "view" });
    const audits = await auditOf(w.t, "access.list");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ workspaceId: w.ws, actorUserId: w.owner, details: { removedCount: 2 } });
  });

  test("the version is the object's when Convex held the object's version: it becomes record.version, and no outbox opens", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    await objectHome(w.t, w.ws);
    const mia = await addUser(w.t, "mia@example.test");
    await userGrant(w.t, w.ws, (await rowOf(w.t, w.ws, PLAN))!._id, mia, "view", w.owner);

    const answer = await w.t.mutation(internal.functions.objectAccessMirror.dropGrantee, {
      workspaceId: w.ws,
      objectAt: 61,
      record: dropRecord(mia, w.owner, { baseVersion: 3, version: 9 }),
    });
    expect(answer).toEqual({ applied: true });
    expect((await stateOf(w.t, w.ws))?.version).toBe(9);
    expect(await outbox(w.t)).toEqual([]);
  });

  test("the version is one above the object's when Convex held a version the object did not see, and an access push is queued", async () => {
    const w = await world();
    // Convex is at 4 and the object decided from 3: Convex took its own access change in between.
    await seedState(w.t, w.ws, 4);
    await objectHome(w.t, w.ws);
    const mia = await addUser(w.t, "mia@example.test");
    await userGrant(w.t, w.ws, (await rowOf(w.t, w.ws, PLAN))!._id, mia, "view", w.owner);

    const answer = await w.t.mutation(internal.functions.objectAccessMirror.dropGrantee, {
      workspaceId: w.ws,
      objectAt: 62,
      record: dropRecord(mia, w.owner, { baseVersion: 3, version: 4 }),
    });
    expect(answer).toEqual({ applied: true });
    expect((await stateOf(w.t, w.ws))?.version).toBe(5);
    expect(await outbox(w.t)).toContainEqual(expect.objectContaining({ workspaceId: w.ws, access: true, nodeIds: [] }));
  });

  test("a grant of the same user in another workspace is untouched", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const mia = await addUser(w.t, "mia@example.test");
    await userGrant(w.t, w.ws, (await rowOf(w.t, w.ws, PLAN))!._id, mia, "view", w.owner);
    const elsewhere = await w.t.run((ctx) =>
      ctx.db.insert("nodes", { workspaceId: w.other, path: PLAN, name: "plan.md", kind: "file", observedAt: 1 }),
    );
    await userGrant(w.t, w.other, elsewhere, mia, "edit", w.owner);

    const answer = await w.t.mutation(internal.functions.objectAccessMirror.dropGrantee, {
      workspaceId: w.ws,
      objectAt: 63,
      record: dropRecord(mia, w.owner),
    });
    expect(answer).toEqual({ applied: true });

    expect(await grantsOfUser(w.t, w.ws, mia)).toEqual([]);
    const otherGrants = await grantsOfUser(w.t, w.other, mia);
    expect(otherGrants).toHaveLength(1);
    expect(otherGrants[0]).toMatchObject({ nodeId: elsewhere, role: "edit" });
    expect(await auditOf(w.t, "access.list")).toHaveLength(1);
  });

  test("an id that is not a users id answers bad_grantee, and writes nothing", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const mia = await addUser(w.t, "mia@example.test");
    await userGrant(w.t, w.ws, (await rowOf(w.t, w.ws, PLAN))!._id, mia, "view", w.owner);

    expect(
      await w.t.mutation(internal.functions.objectAccessMirror.dropGrantee, {
        workspaceId: w.ws,
        objectAt: 64,
        record: dropRecord("not-an-id", w.owner),
      }),
    ).toEqual({ applied: false, reason: "bad_grantee" });

    expect(await grantsOfUser(w.t, w.ws, mia)).toHaveLength(1);
    expect((await stateOf(w.t, w.ws))?.version).toBe(3);
    expect(await auditOf(w.t, "access.list")).toEqual([]);
    expect(await outbox(w.t)).toEqual([]);
  });
});

describe("objectAccessMirror.narrowBases", () => {
  type Pin = { rowId: string; base: "private" | "team" };
  const narrowRecord = (rows: Pin[], extra: { baseVersion?: number; version?: number } = {}) => ({
    rows,
    baseVersion: extra.baseVersion ?? 3,
    version: extra.version ?? 4,
  });

  test("two live rows pinned private: applied, both take private, and each row's objectAt is the one passed", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const planId = await rowIdOf(w.t, w.ws, PLAN);
    const groupId = await rowIdOf(w.t, w.ws, GROUP_VIEW);
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.narrowBases, {
      workspaceId: w.ws,
      objectAt: 70,
      record: narrowRecord([
        { rowId: planId, base: "private" },
        { rowId: groupId, base: "private" },
      ]),
    });
    expect(answer).toEqual({ applied: true });
    for (const path of [PLAN, GROUP_VIEW]) {
      const row = await rowOf(w.t, w.ws, path);
      expect(row?.access?.base).toBe("private");
      expect(row?.objectAt).toBe(70);
    }
  });

  test("a row already at that base: applied, and the base is left as it was", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const rowId = await rowIdOf(w.t, w.ws, PLAN);
    await w.t.run((ctx) => ctx.db.patch(rowId as Id<"nodes">, { access: { base: "private" } }));
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.narrowBases, {
      workspaceId: w.ws,
      objectAt: 71,
      record: narrowRecord([{ rowId, base: "private" }]),
    });
    expect(answer).toEqual({ applied: true });
    expect((await rowOf(w.t, w.ws, PLAN))?.access).toEqual({ base: "private" });
  });

  test("the version is the object's when Convex held the object's version: it becomes record.version, and no outbox opens", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    await objectHome(w.t, w.ws);
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.narrowBases, {
      workspaceId: w.ws,
      objectAt: 72,
      record: narrowRecord([{ rowId: await rowIdOf(w.t, w.ws, PLAN), base: "private" }], { baseVersion: 3, version: 4 }),
    });
    expect(answer).toEqual({ applied: true });
    expect((await stateOf(w.t, w.ws))?.version).toBe(4);
    expect(await outbox(w.t)).toEqual([]);
  });

  test("a version the object did not see: the version is one above the object's, and an access push is queued", async () => {
    const w = await world();
    // Convex is at 4 and the object decided from 3: Convex took its own access change in between.
    await seedState(w.t, w.ws, 4);
    await objectHome(w.t, w.ws);
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.narrowBases, {
      workspaceId: w.ws,
      objectAt: 73,
      record: narrowRecord([{ rowId: await rowIdOf(w.t, w.ws, PLAN), base: "private" }], { baseVersion: 3, version: 4 }),
    });
    expect(answer).toEqual({ applied: true });
    expect((await stateOf(w.t, w.ws))?.version).toBe(5);
    expect(await outbox(w.t)).toContainEqual(expect.objectContaining({ workspaceId: w.ws, access: true, nodeIds: [] }));
  });

  test("a row id that names no live row here is skipped: applied, the live row is pinned, and another workspace's row is unchanged", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const elsewhere = await w.t.run((ctx) =>
      ctx.db.insert("nodes", { workspaceId: w.other, path: PLAN, name: "plan.md", kind: "file", observedAt: 1 }),
    );
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.narrowBases, {
      workspaceId: w.ws,
      objectAt: 74,
      record: narrowRecord([
        { rowId: elsewhere, base: "private" },
        { rowId: await rowIdOf(w.t, w.ws, GROUP_VIEW), base: "private" },
      ]),
    });
    expect(answer).toEqual({ applied: true });
    expect((await rowOf(w.t, w.ws, GROUP_VIEW))?.access).toEqual({ base: "private" });
    const otherRow = await w.t.run((ctx) => ctx.db.get(elsewhere));
    expect(otherRow?.access).toBeUndefined();
    expect(otherRow?.objectAt).toBeUndefined();
  });

  test("more than 500 rows answers bad_record, and writes nothing", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const planId = await rowIdOf(w.t, w.ws, PLAN);
    const rows: Pin[] = Array.from({ length: 501 }, () => ({ rowId: planId, base: "private" as const }));
    expect(
      await w.t.mutation(internal.functions.objectAccessMirror.narrowBases, {
        workspaceId: w.ws,
        objectAt: 75,
        record: narrowRecord(rows),
      }),
    ).toEqual({ applied: false, reason: "bad_record" });
    expect((await rowOf(w.t, w.ws, PLAN))?.access).toBeUndefined();
    expect((await rowOf(w.t, w.ws, PLAN))?.objectAt).toBeUndefined();
    expect((await stateOf(w.t, w.ws))?.version).toBe(3);
    expect(await outbox(w.t)).toEqual([]);
  });
});
