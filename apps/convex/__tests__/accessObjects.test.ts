/**
 * The record of where each workspace's access is read from (decided by the
 * owner, 2026-11-01, plan "Access lives in the objects";
 * `functions/accessObjectsRows.ts`, `lib/accessObjects/home.ts`).
 *
 * Sabotage, each confirmed to fail a case here: read the workspace switch for
 * the person scope (or the reverse), let a record with no access field read as
 * anything but `convex`, let setting one scope move the other, or overwrite the
 * notes switch when the access switch is set on a workspace with no record.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { modules } from "../test.setup";
import { internal } from "../_generated/api";

async function workspace(t: ReturnType<typeof convexTest>, kind: "personal" | "shared" = "shared") {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {} as never);
    return await ctx.db.insert("workspaces", { slug: "acme", displayName: "Acme", createdBy: userId, kind, structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never);
  });
}

describe("access switch record", () => {
  test("no record, or a notes-only record, is convex for both scopes", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await workspace(t);
    for (const scope of ["workspace", "person"] as const) {
      expect(await t.query(internal.functions.accessObjectsRows.accessOf, { workspaceId, scope })).toBe("convex");
    }
    await t.mutation(internal.functions.workspaceObjectsRows.recordHome, { workspaceId, home: "dual", now: 5 });
    for (const scope of ["workspace", "person"] as const) {
      expect(await t.query(internal.functions.accessObjectsRows.accessOf, { workspaceId, scope })).toBe("convex");
    }
  });

  test("each scope moves alone, and the notes switch is never touched", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await workspace(t, "personal");
    await t.mutation(internal.functions.accessObjectsRows.recordAccess, { workspaceId, scope: "workspace", home: "dual", now: 10 });
    expect(await t.query(internal.functions.accessObjectsRows.accessOf, { workspaceId, scope: "workspace" })).toBe("dual");
    expect(await t.query(internal.functions.accessObjectsRows.accessOf, { workspaceId, scope: "person" })).toBe("convex");
    expect(await t.query(internal.functions.workspaceObjectsRows.homeOf, { workspaceId })).toBe("bucket");

    await t.mutation(internal.functions.workspaceObjectsRows.recordHome, { workspaceId, home: "dual", now: 15 });
    await t.mutation(internal.functions.accessObjectsRows.recordAccess, { workspaceId, scope: "person", home: "object", now: 20 });
    expect(await t.query(internal.functions.accessObjectsRows.accessOf, { workspaceId, scope: "person" })).toBe("object");
    expect(await t.query(internal.functions.accessObjectsRows.accessOf, { workspaceId, scope: "workspace" })).toBe("dual");
    expect(await t.query(internal.functions.workspaceObjectsRows.homeOf, { workspaceId })).toBe("dual");

    // The rollback is one step back.
    await t.mutation(internal.functions.accessObjectsRows.recordAccess, { workspaceId, scope: "person", home: "dual", now: 30 });
    expect(await t.query(internal.functions.accessObjectsRows.accessOf, { workspaceId, scope: "person" })).toBe("dual");
  });

  test("copy time and parity are kept per scope", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await workspace(t, "personal");
    await t.mutation(internal.functions.accessObjectsRows.recordAccess, { workspaceId, scope: "workspace", home: "dual", now: 10 });
    await t.mutation(internal.functions.accessObjectsRows.recordAccessCopy, { workspaceId, scope: "person", at: 11 });
    const tables = [{ table: "reach", convex: 2, object: 2, match: true }];
    await t.mutation(internal.functions.accessObjectsRows.recordAccessParity, { workspaceId, scope: "person", parity: { at: 12, tables } });
    expect(await t.query(internal.functions.accessObjectsRows.accessRecordFor, { workspaceId, scope: "person" })).toEqual({ home: "convex", backfilledAt: 11, parity: { at: 12, tables } });
    expect(await t.query(internal.functions.accessObjectsRows.accessRecordFor, { workspaceId, scope: "workspace" })).toEqual({ home: "dual" });
  });

  test("workspaceFacts names a personal workspace's one owner", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {} as never);
      const workspaceId = await ctx.db.insert("workspaces", { slug: "seyi", displayName: "S", createdBy: userId, kind: "personal", structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never);
      await ctx.db.insert("workspaceMembers", { workspaceId, userId, role: "owner", joinedAt: 1 });
      return { workspaceId, userId };
    });
    expect(await t.query(internal.functions.accessObjectsRows.workspaceFacts, { workspaceId })).toEqual({ personal: true, personId: userId });
  });
});

describe("switching every workspace", () => {
  test("a dry run counts what may go to object and why the rest may not; a run that cannot reach the object switches nothing", async () => {
    const t = convexTest(schema, modules);
    const ready = await workspace(t);
    const unchecked = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {} as never);
      return await ctx.db.insert("workspaces", { slug: "beta", displayName: "Beta", createdBy: userId, kind: "shared", structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never);
    });
    const now = Date.now();
    for (const workspaceId of [ready, unchecked]) {
      await t.mutation(internal.functions.accessObjectsRows.recordAccess, { workspaceId, scope: "workspace", home: "dual", now });
      await t.mutation(internal.functions.accessObjectsRows.recordAccessCopy, { workspaceId, scope: "workspace", at: now });
    }
    await t.mutation(internal.functions.accessObjectsRows.recordAccessParity, {
      workspaceId: ready,
      scope: "workspace",
      parity: { at: now, tables: [{ table: "members", convex: 1, object: 1, match: true }, { table: "invites", convex: 0, object: 0, match: true }] },
    });

    const dry = await t.action(internal.functions.accessObjects.setAccessEvery, { home: "object", scope: "workspace", dryRun: true });
    expect(dry).toMatchObject({ scopes: 2, switched: 1, already: 0, refused: [{ reason: "PARITY_STALE", count: 1 }], done: true });

    const again = await t.action(internal.functions.accessObjects.setAccessEvery, { home: "dual", scope: "workspace", dryRun: true });
    expect(again).toMatchObject({ scopes: 2, switched: 0, already: 2, refused: [] });

    // No gateway in this deployment: the object cannot take the switch, so the record stays where it was.
    const real = await t.action(internal.functions.accessObjects.setAccessEvery, { home: "object", scope: "workspace", dryRun: false });
    expect(real).toMatchObject({ switched: 0, refused: [{ reason: "OBJECT_UNREACHABLE", count: 2 }] });
    for (const workspaceId of [ready, unchecked]) {
      expect(await t.query(internal.functions.accessObjectsRows.accessOf, { workspaceId, scope: "workspace" })).toBe("dual");
    }
  });
});
