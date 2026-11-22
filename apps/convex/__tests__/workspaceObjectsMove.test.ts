/**
 * Every workspace moved onto its workspace object on its own (`functions/workspaceObjectsMove.ts`,
 * `workspaceObjectsMoveRows.ts`, `lib/workspaceObjects/moveStep.ts`; owner, 2026-11-20).
 *
 * Sabotage, each confirmed to fail a case here: skip a bucket of the workspace's own again (owner, 2026-11-22: it moves
 * like a managed one), jump `dual` straight to access (notes never compared), switch texting before the person's access is in the
 * object, let a second run take a held workspace, sweep a workspace tried within the hour, and leave a new managed
 * bucket's binding without a run scheduled.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { modules } from "../test.setup";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { managedBucketName } from "../functions/lib/managedStorage";
import { nextMoveStep, type MoveFacts } from "../functions/lib/workspaceObjects/moveStep";

const base: MoveFacts = {
  exists: true,
  storage: "managed",
  personal: true,
  hasPerson: true,
  notes: "bucket",
  access: "convex",
  personAccess: "convex",
  texting: "convex",
};

describe("the next step", () => {
  test("goes notes, then access, then texting, and only through dual", () => {
    expect(nextMoveStep(base).step).toBe("notes_arm");
    expect(nextMoveStep({ ...base, notes: "dual" }).step).toBe("notes_copy_check");
    expect(nextMoveStep({ ...base, notes: "dual", access: "object", personAccess: "object" }).step).toBe("notes_copy_check");
    expect(nextMoveStep({ ...base, notes: "object" }).step).toBe("access_arm");
    expect(nextMoveStep({ ...base, notes: "object", access: "object" }).step).toBe("access_arm");
    expect(nextMoveStep({ ...base, notes: "object", access: "dual", personAccess: "dual" }).step).toBe("access_copy_check");
    expect(nextMoveStep({ ...base, notes: "object", access: "object", personAccess: "dual" }).step).toBe("access_copy_check");
    expect(nextMoveStep({ ...base, notes: "object", access: "object", personAccess: "object" }).step).toBe("texting_push");
    expect(nextMoveStep({ ...base, notes: "object", access: "object", personAccess: "object", texting: "object" }).step).toBe("done");
  });

  test("a shared workspace has no person and no texting", () => {
    const shared = { ...base, personal: false, hasPerson: false, notes: "object" as const, access: "object" as const };
    expect(nextMoveStep(shared).step).toBe("done");
  });

  test("a bucket of the workspace's own moves like a managed one", () => {
    const own = { ...base, storage: "own" as const };
    expect(nextMoveStep(own).step).toBe("notes_arm");
    expect(nextMoveStep({ ...own, notes: "dual" }).step).toBe("notes_copy_check");
    expect(nextMoveStep({ ...own, notes: "object" }).step).toBe("access_arm");
    expect(nextMoveStep({ ...own, notes: "object", access: "object", personAccess: "object", texting: "object" }).step).toBe("done");
  });

  test("no storage or a gone workspace is never moved", () => {
    expect(nextMoveStep({ ...base, storage: "none" })).toEqual({ step: "skip", why: "no_storage" });
    expect(nextMoveStep({ ...base, exists: false })).toEqual({ step: "skip", why: "gone" });
  });
});

async function workspace(t: ReturnType<typeof convexTest>, kind: "personal" | "shared", storage: "managed" | "own" | "none"): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {} as never);
    const workspaceId = await ctx.db.insert("workspaces", { slug: `w${Math.random().toString(36).slice(2, 10)}`, displayName: "W", createdBy: userId, kind, structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never);
    await ctx.db.insert("workspaceMembers", { workspaceId, userId, role: "owner", joinedAt: 1 } as never);
    if (storage !== "none") {
      await ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "r2",
        endpoint: "https://example.invalid",
        region: "auto",
        bucket: storage === "managed" ? managedBucketName(workspaceId) : "their-own-bucket",
        capabilities: { conditionalWrite: true },
        status: "connected",
        boundBy: userId,
        createdAt: 1,
        updatedAt: 1,
      } as never);
    }
    return workspaceId;
  });
}

describe("facts, lease, sweep and census", () => {
  test("facts tell managed storage from a bucket of one's own", async () => {
    const t = convexTest(schema, modules);
    const managed = await workspace(t, "personal", "managed");
    const own = await workspace(t, "shared", "own");
    const none = await workspace(t, "shared", "none");
    expect(await t.query(internal.functions.workspaceObjectsMoveRows.factsFor, { workspaceId: managed })).toMatchObject({ storage: "managed", personal: true, hasPerson: true, notes: "bucket" });
    expect((await t.query(internal.functions.workspaceObjectsMoveRows.factsFor, { workspaceId: own })).storage).toBe("own");
    expect((await t.query(internal.functions.workspaceObjectsMoveRows.factsFor, { workspaceId: none })).storage).toBe("none");
  });

  test("one run at a time holds a workspace, and a released one waits out the hour before the sweep takes it again", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await workspace(t, "shared", "managed");
    expect(await t.query(internal.functions.workspaceObjectsMoveRows.toMove, { now: 10 })).toEqual([workspaceId]);
    await t.mutation(internal.functions.workspaceObjectsRows.recordHome, { workspaceId, home: "dual", now: 10 });
    expect(await t.mutation(internal.functions.workspaceObjectsMoveRows.claimMove, { workspaceId, now: 10, until: 1000 })).toBe(true);
    expect(await t.mutation(internal.functions.workspaceObjectsMoveRows.claimMove, { workspaceId, now: 20, until: 2000 })).toBe(false);
    expect(await t.query(internal.functions.workspaceObjectsMoveRows.toMove, { now: 20 })).toEqual([]);
    await t.mutation(internal.functions.workspaceObjectsMoveRows.releaseMove, { workspaceId, now: 30, note: "notes_parity_differs" });
    expect(await t.query(internal.functions.workspaceObjectsMoveRows.toMove, { now: 40 })).toEqual([]);
    expect(await t.query(internal.functions.workspaceObjectsMoveRows.toMove, { now: 30 + 60 * 60 * 1000 })).toEqual([workspaceId]);
    expect(await t.mutation(internal.functions.workspaceObjectsMoveRows.claimMove, { workspaceId, now: 40, until: 2000 })).toBe(true);
  });

  test("the sweep lists a bucket of one's own, never no storage or a workspace already moved", async () => {
    const t = convexTest(schema, modules);
    const own = await workspace(t, "shared", "own");
    await workspace(t, "shared", "none");
    const moved = await workspace(t, "shared", "managed");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceObjectHomes", { workspaceId: moved, home: "object", since: 1, access: "object" } as never);
    });
    expect(await t.query(internal.functions.workspaceObjectsMoveRows.toMove, { now: 10 })).toEqual([own]);
  });

  test("the census counts by storage and home, moved and not, in counts only", async () => {
    const t = convexTest(schema, modules);
    await workspace(t, "shared", "own");
    await workspace(t, "personal", "none");
    const moved = await workspace(t, "shared", "managed");
    const fresh = await workspace(t, "personal", "managed");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceObjectHomes", { workspaceId: moved, home: "object", since: 1, access: "object" } as never);
    });
    const census = await t.query(internal.functions.workspaceObjectsMoveRows.census, {});
    expect(census).toMatchObject({
      workspaces: 4,
      storage: { none: 1, own: 1, managed: 2 },
      moved: 1,
      notMoved: 2,
      next: { notes_arm: 2 },
      lastNote: { never_tried: 2 },
      notes: { bucket: 2, dual: 0, object: 1 },
      ownNotes: { bucket: 1 },
      texFolders: { none: 4, one: 0, many: 0 },
    });
    expect(JSON.stringify(census)).not.toContain(String(fresh));
    // Two live folders doing the `tex` job is counted as many, and a gone one is not counted.
    await t.run(async (ctx) => {
      const base = { workspaceId: fresh, kind: "folder" as const, role: "tex", name: "tex", observedAt: 1 };
      await ctx.db.insert("nodes", { ...base, path: "tex" } as never);
      await ctx.db.insert("nodes", { ...base, path: "Tex 2", name: "Tex 2" } as never);
      await ctx.db.insert("nodes", { ...base, workspaceId: moved, path: "tex" } as never);
      await ctx.db.insert("nodes", { ...base, workspaceId: moved, path: "old", name: "old", goneAt: 5 } as never);
    });
    const after = await t.query(internal.functions.workspaceObjectsMoveRows.census, {});
    expect(after.texFolders).toEqual({ none: 2, one: 1, many: 1 });
  });
});

describe("born on its object", () => {
  test("binding a new managed bucket schedules the workspace's move straight away", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await workspace(t, "shared", "none");
    const actorUserId = await t.run(async (ctx) => (await ctx.db.get(workspaceId))!.createdBy as Id<"users">);
    await t.mutation(internal.functions.managedProvisioning.completeManagedProvisioning, {
      workspaceId,
      actorUserId,
      endpoint: "https://example.invalid",
      bucket: managedBucketName(workspaceId),
      accessKeyId: "AKIAFAKE",
      encryptedSecretAccessKey: "v2:test:aaaa:bbbb",
    } as never);
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const moves = jobs.filter((job) => job.name.includes("workspaceObjectsMove") && job.name.includes("advance"));
    expect(moves).toHaveLength(1);
    expect(moves[0]!.args[0]).toEqual({ workspaceId });
  });
});
