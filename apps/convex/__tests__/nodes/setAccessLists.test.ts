/**
 * Hardening the access-list writer (`lib/nodes/setAccess.ts`):
 *  - a tier change with no `grantees` keeps the owner's list; only an explicit list (or `[]`) replaces it;
 *  - at most `MAX_GRANTEES` grantees, refused as `INVALID` before anything is written;
 *  - a malformed id from the gateway is `INVALID`, never a thrown error;
 *  - a missing account and a deleted one give byte-identical refusals;
 *  - every list change writes one `access.list` audit row, and a refused change writes none.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - make `setAccessRow` treat an absent `grantees` as `[]` again: "a tier change keeps the owner's list" fails;
 *  - drop the `|| base === "inherit"` in `replaces`: "a reset to inherit clears the owner's list" fails;
 *  - drop the `MAX_GRANTEES` check: "101 grantees are refused" fails;
 *  - drop the `normalizeId` check in `nodesAccess.setAccess`: "a malformed id is INVALID" fails;
 *  - drop the `recordAudit` call: "a list change writes one audit row" fails;
 *  - move the audit or the cap check after the first write: "a refused change writes no audit row" fails.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { setAccessRow } from "../../functions/lib/nodes/setAccess";
import { gatewayPost } from "../fixtures.helpers";
import {
  ACCESS_A,
  bodyOf,
  twoConnectedTenants,
} from "../controlPlane/fixtures.helpers";
import { parentRows } from "./treeRows.helpers";
import { nodeAt as treeNodeAt } from "../../functions/lib/nodes/paths";

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;

interface World {
  t: T;
  ws: Id<"workspaces">;
  owner: Id<"users">;
  editor: Id<"users">;
  leads: Id<"workspaceGroups">;
}

async function world(): Promise<World> {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { email: "owner@example.test", emailVerificationTime: now } as never);
    const editor = await ctx.db.insert("users", { email: "editor@example.test", emailVerificationTime: now } as never);
    const ws = await ctx.db.insert("workspaces", {
      slug: "acme",
      displayName: "acme",
      createdBy: owner,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: owner, role: "owner", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: editor, role: "editor", joinedAt: now });
    const leads = await ctx.db.insert("workspaceGroups", { workspaceId: ws, name: "acme-leads", createdBy: owner, createdAt: now });
    await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: now });
    for (const path of ["1-projects", "1-projects/plan.md"]) {
      await ctx.db.insert("nodes", {
        workspaceId: ws,
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        kind: path.endsWith(".md") ? "file" : "folder",
        observedAt: 1,
      });
    }
    await parentRows(ctx, ws);
    return { ws, owner, editor, leads };
  });
  return { t, ...ids };
}

async function rowAt(t: T, ws: Id<"workspaces">, path: string) {
  return await t.run(async (ctx) => treeNodeAt(ctx.db, ws, path));
}

async function grantsOn(t: T, ws: Id<"workspaces">, path: string) {
  const row = await rowAt(t, ws, path);
  if (row === null) throw new Error(`no row at ${path}`);
  return await t.run(async (ctx) =>
    ctx.db
      .query("nodeAccess")
      .withIndex("by_node", (q) => q.eq("nodeId", row._id))
      .collect(),
  );
}

async function versionOf(t: T, ws: Id<"workspaces">): Promise<number> {
  return await t.run(async (ctx) => {
    const state = await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", ws))
      .unique();
    return state?.version ?? 0;
  });
}

async function listAudit(t: T) {
  return await t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((event) => event.action === "access.list"));
}

function owner(w: World) {
  return { userId: w.owner, role: "owner" as const };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("a tier change keeps the owner's list", () => {
  test("setAccessRow with no grantees keeps the owner's grant (the same grant row) and bumps the version", async () => {
    const w = await world();
    const leads = { kind: "group" as const, groupId: w.leads, role: "view" as const };
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", grantees: [leads], actor: owner(w) }),
    );
    const before = await grantsOn(w.t, w.ws, "1-projects/plan.md");
    expect(before).toHaveLength(1);

    const answer = await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "team", actor: owner(w) }),
    );
    expect(answer).toMatchObject({ ok: true });
    expect((await rowAt(w.t, w.ws, "1-projects/plan.md"))?.access).toEqual({ base: "team" });
    // Untouched: the same grant row, not a deleted and re-inserted copy.
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toEqual(before);
    expect(await versionOf(w.t, w.ws)).toBe(2);
  });

  test("an editor's tier change on a row with an owner's list is allowed, and keeps the list", async () => {
    const w = await world();
    const leads = { kind: "group" as const, groupId: w.leads, role: "view" as const };
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", grantees: [leads], actor: owner(w) }),
    );
    const before = await grantsOn(w.t, w.ws, "1-projects/plan.md");
    const answer = await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, {
        workspaceId: w.ws,
        path: "1-projects/plan.md",
        base: "team",
        actor: { userId: w.editor, role: "editor" },
      }),
    );
    expect(answer).toMatchObject({ ok: true });
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toEqual(before);
  });

  test("the console's tier change keeps the owner's list", async () => {
    const w = await world();
    const leads = { kind: "group" as const, groupId: w.leads, role: "view" as const };
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", grantees: [leads], actor: owner(w) }),
    );
    const answer = await w.t.mutation(internal.functions.nodesAccess.consoleAccess, {
      workspaceId: w.ws,
      actorUserId: w.owner,
      path: "1-projects/plan.md",
      kind: "note",
      tier: "team",
    });
    expect(answer).toMatchObject({ ok: true, visibility: "team" });
    expect((await rowAt(w.t, w.ws, "1-projects/plan.md"))?.access).toEqual({ base: "team" });
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toMatchObject([
      { granteeKind: "group", granteeGroupId: w.leads, role: "view", source: "owner" },
    ]);
  });

  test("the gateway's tier change (no grantees in the body) keeps the owner's list", async () => {
    const tenants = await twoConnectedTenants();
    const { t, aliceWs } = tenants;
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: now });
      const creator = await ctx.db.insert("users", { email: "creator@example.test", emailVerificationTime: now } as never);
      const group = await ctx.db.insert("workspaceGroups", { workspaceId: aliceWs, name: "alice-leads", createdBy: creator, createdAt: now });
      const row = await ctx.db.insert("nodes", { workspaceId: aliceWs, path: "1-projects", name: "1-projects", kind: "folder", observedAt: now });
      await ctx.db.insert("nodeAccess", {
        workspaceId: aliceWs,
        nodeId: row,
        granteeKind: "group",
        granteeGroupId: group,
        role: "view",
        at: now,
        source: "owner",
      });
    });
    const before = await t.run(async (ctx) => {
      const row = await treeNodeAt(ctx.db, aliceWs, "1-projects");
      return await ctx.db
        .query("nodeAccess")
        .withIndex("by_node", (q) => q.eq("nodeId", row!._id))
        .collect();
    });
    expect(before).toHaveLength(1);
    const answer = await bodyOf(
      await gatewayPost(t, "/gateway/privacy", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, op: "setAccess", path: "1-projects", base: "team" }),
    );
    expect(answer).toEqual({ ok: true, version: 1 });
    const after = await t.run(async (ctx) => {
      const row = await treeNodeAt(ctx.db, aliceWs, "1-projects");
      return await ctx.db
        .query("nodeAccess")
        .withIndex("by_node", (q) => q.eq("nodeId", row!._id))
        .collect();
    });
    expect(after).toEqual(before);
  }, 30_000);

  test("an explicit empty list clears the owner's list, both in the function and on the gateway route", async () => {
    const w = await world();
    const leads = { kind: "group" as const, groupId: w.leads, role: "view" as const };
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", grantees: [leads], actor: owner(w) }),
    );
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", grantees: [], actor: owner(w) }),
    );
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toHaveLength(0);

    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", grantees: [leads], actor: owner(w) }),
    );
    const { t, aliceWs } = await twoConnectedTenants();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: now });
      await ctx.db.insert("nodes", { workspaceId: aliceWs, path: "1-projects", name: "1-projects", kind: "folder", observedAt: now });
    });
    const answer = await bodyOf(
      await gatewayPost(t, "/gateway/privacy", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
        op: "setAccess",
        path: "1-projects",
        base: "team",
        grantees: [],
      }),
    );
    expect(answer).toEqual({ ok: true, version: 1 });
  });
});

describe("a reset to inherit clears the owner's list, and team to private keeps it", () => {
  async function ownerGroupOn(w: World, path: string): Promise<void> {
    const leads = { kind: "group" as const, groupId: w.leads, role: "view" as const };
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path, base: "private", grantees: [leads], actor: owner(w) }),
    );
  }

  // Was "a console reset ... clears the owner's list with it". The share dialog (boards 1 to 4, 2026-10-16) puts
  // the tier beside the list as "everyone else in the workspace": changing it keeps the people named on the note,
  // so a tier on a listed note is written as the note's own base instead of resetting it to inherit. A note with
  // no list still resets (`shareList.test.ts` covers the team case).
  test("a console tier on a listed note keeps the owner's list, as the note's own base", async () => {
    const w = await world();
    await ownerGroupOn(w, "1-projects/plan.md");
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toHaveLength(1);
    // The folder above is private by default, so "private" on the note is what it inherits.
    const answer = await w.t.mutation(internal.functions.nodesAccess.consoleAccess, {
      workspaceId: w.ws,
      actorUserId: w.owner,
      path: "1-projects/plan.md",
      kind: "note",
      tier: "private",
    });
    expect(answer).toMatchObject({ ok: true, exception: false });
    expect((await rowAt(w.t, w.ws, "1-projects/plan.md"))?.access).toEqual({ base: "private" });
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toHaveLength(1);
  });

  test("a console tier on a note with no list still resets it to inherit", async () => {
    const w = await world();
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "team", actor: owner(w) }),
    );
    await w.t.mutation(internal.functions.nodesAccess.consoleAccess, {
      workspaceId: w.ws,
      actorUserId: w.owner,
      path: "1-projects/plan.md",
      kind: "note",
      tier: "private",
    });
    expect((await rowAt(w.t, w.ws, "1-projects/plan.md"))?.access ?? undefined).toBeUndefined();
  });

  test("a gateway reset to inherit clears the owner's list with it", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: now });
      const creator = await ctx.db.insert("users", { email: "creator@example.test", emailVerificationTime: now } as never);
      const group = await ctx.db.insert("workspaceGroups", { workspaceId: aliceWs, name: "alice-leads", createdBy: creator, createdAt: now });
      const row = await ctx.db.insert("nodes", { workspaceId: aliceWs, path: "1-projects", name: "1-projects", kind: "folder", observedAt: now, access: { base: "team" } });
      await ctx.db.insert("nodeAccess", { workspaceId: aliceWs, nodeId: row, granteeKind: "group", granteeGroupId: group, role: "view", at: now, source: "owner" });
    });
    const answer = await bodyOf(
      await gatewayPost(t, "/gateway/privacy", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, op: "setAccess", path: "1-projects", base: "inherit" }),
    );
    expect(answer).toEqual({ ok: true, version: 1 });
    const row = await t.run(async (ctx) =>
      treeNodeAt(ctx.db, aliceWs, "1-projects"),
    );
    expect(row?.access).toBeUndefined();
    const grants = await t.run(async (ctx) => ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row!._id)).collect());
    expect(grants).toHaveLength(0);
  }, 30_000);

  test("a change from team to private with no list keeps the owner's list", async () => {
    const w = await world();
    await ownerGroupOn(w, "1-projects/plan.md");
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "team", actor: owner(w) }),
    );
    const before = await grantsOn(w.t, w.ws, "1-projects/plan.md");
    expect(before).toHaveLength(1);
    const answer = await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", actor: owner(w) }),
    );
    expect(answer).toMatchObject({ ok: true });
    expect((await rowAt(w.t, w.ws, "1-projects/plan.md"))?.access).toEqual({ base: "private" });
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toEqual(before);
  });
});

describe("the cap on grantees", () => {
  const emails = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "email" as const, email: `user${i}@example.test`, role: "view" as const }));

  test("101 grantees are refused with INVALID, and nothing is written", async () => {
    const w = await world();
    const leads = { kind: "group" as const, groupId: w.leads, role: "view" as const };
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", grantees: [leads], actor: owner(w) }),
    );
    const before = await grantsOn(w.t, w.ws, "1-projects/plan.md");
    const access = (await rowAt(w.t, w.ws, "1-projects/plan.md"))?.access;
    const version = await versionOf(w.t, w.ws);
    const answer = await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "team", grantees: emails(101), actor: owner(w) }),
    );
    expect(answer).toEqual({ ok: false, code: "INVALID" });
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toEqual(before);
    expect((await rowAt(w.t, w.ws, "1-projects/plan.md"))?.access).toEqual(access);
    expect(access).toEqual({ base: "private" });
    expect(await versionOf(w.t, w.ws)).toBe(version);
  });

  test("100 grantees are accepted", async () => {
    const w = await world();
    const answer = await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", grantees: emails(100), actor: owner(w) }),
    );
    expect(answer).toMatchObject({ ok: true });
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toHaveLength(100);
  });

  test("the gateway route refuses 101 as INVALID too", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: now });
      await ctx.db.insert("nodes", { workspaceId: aliceWs, path: "1-projects", name: "1-projects", kind: "folder", observedAt: now });
    });
    const grantees = Array.from({ length: 101 }, (_, i) => ({ kind: "email", email: `user${i}@example.test`, role: "view" }));
    const answer = await bodyOf(
      await gatewayPost(t, "/gateway/privacy", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, op: "setAccess", path: "1-projects", base: "team", grantees }),
    );
    expect(answer).toEqual({ ok: false, code: "INVALID" });
  });
});

describe("the gateway's ids are validated, not cast", () => {
  test("a malformed user or group id is INVALID, not an exception, and nothing is written", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: now });
      await ctx.db.insert("nodes", { workspaceId: aliceWs, path: "1-projects", name: "1-projects", kind: "folder", observedAt: now });
    });
    for (const grantee of [
      { kind: "user", userId: "not-an-id", role: "view" },
      { kind: "group", groupId: "nope", role: "edit" },
    ]) {
      const answer = await bodyOf(
        await gatewayPost(t, "/gateway/privacy", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, op: "setAccess", path: "1-projects", base: "team", grantees: [grantee] }),
      );
      expect(answer).toEqual({ ok: false, code: "INVALID" });
    }
    const rows = await t.run(async (ctx) => await ctx.db.query("nodeAccess").collect());
    expect(rows).toHaveLength(0);
    const row = await rowAt(t, aliceWs, "1-projects");
    expect(row?.access).toBeUndefined();
  });

  test("the internal mutation answers INVALID for a malformed id instead of throwing", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: now });
      await ctx.db.insert("nodes", { workspaceId: aliceWs, path: "1-projects", name: "1-projects", kind: "folder", observedAt: now });
    });
    const answer = await t.mutation(internal.functions.nodesAccess.setAccess, {
      workspaceId: aliceWs,
      path: "1-projects",
      base: "team",
      grantees: [{ kind: "user", userId: "bogus", role: "view" }],
      actor: { userId: (await t.run(async (ctx) => (await ctx.db.query("workspaceMembers").first())!.userId)), role: "owner" },
    });
    expect(answer).toEqual({ ok: false, code: "INVALID" });
  });
});

describe("a user grantee that cannot be addressed", () => {
  test("a missing account and a deleted one give byte-identical refusals, and write nothing", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: now });
      await ctx.db.insert("nodes", { workspaceId: aliceWs, path: "1-projects", name: "1-projects", kind: "folder", observedAt: now });
    });
    // An id of the right shape that names nobody here: the last of many users inserted into a second instance,
    // so its number is past every id this instance has issued (the guard below checks it).
    const elsewhere = makeTest();
    const missing = await elsewhere.run(async (ctx) => {
      let last: Id<"users"> | null = null;
      for (let i = 0; i < 25; i++) last = await ctx.db.insert("users", { email: `ghost${i}@example.test` } as never);
      return last!;
    });
    const deleted = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "gone@example.test", emailVerificationTime: Date.now() } as never);
      await ctx.db.delete(id);
      return id;
    });
    expect(await t.run(async (ctx) => ctx.db.get(missing))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(deleted))).toBeNull();

    const refuse = async (userId: Id<"users">) =>
      await bodyOf(
        await gatewayPost(t, "/gateway/privacy", {
          accessToken: ACCESS_A,
          expectedWorkspaceId: aliceWs,
          op: "setAccess",
          path: "1-projects",
          base: "team",
          grantees: [{ kind: "user", userId, role: "view" }],
        }),
      );
    const missingAnswer = await refuse(missing);
    const deletedAnswer = await refuse(deleted);
    expect(JSON.stringify(deletedAnswer)).toBe(JSON.stringify(missingAnswer));
    expect(missingAnswer).toEqual({ ok: false, code: "NOT_FOUND" });
    expect((await rowAt(t, aliceWs, "1-projects"))?.access).toBeUndefined();
  });
});

describe("the audit trail of list changes", () => {
  test("a list change writes one access.list row with the actor, the workspace, the row, counts and grantee ids, and no raw email", async () => {
    const w = await world();
    const leads = { kind: "group" as const, groupId: w.leads, role: "view" as const };
    const answer = await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, {
        workspaceId: w.ws,
        path: "1-projects/plan.md",
        base: "private",
        grantees: [leads, { kind: "email", email: "  Kola@Example.TEST ", role: "edit" }],
        actor: owner(w),
      }),
    );
    expect(answer).toMatchObject({ ok: true });
    const events = await listAudit(w.t);
    expect(events).toHaveLength(1);
    const [event] = events;
    const row = await rowAt(w.t, w.ws, "1-projects/plan.md");
    expect(event.workspaceId).toBe(w.ws);
    expect(event.actorUserId).toBe(w.owner);
    expect(event.details).toMatchObject({
      nodeId: String(row!._id),
      addedCount: 2,
      removedCount: 0,
      added: `group:${w.leads}:view,email:${sha256("kola@example.test")}:edit`,
      removed: "",
    });
    const serialized = JSON.stringify(event).toLowerCase();
    expect(serialized).not.toContain("kola@example.test");
    expect(serialized).not.toContain("kola");
  });

  test("a second change records what it removed and what it added, by id", async () => {
    const w = await world();
    const leads = { kind: "group" as const, groupId: w.leads, role: "view" as const };
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", grantees: [leads], actor: owner(w) }),
    );
    await w.t.run(async (ctx) =>
      setAccessRow(ctx as MutationCtx, {
        workspaceId: w.ws,
        path: "1-projects/plan.md",
        base: "private",
        grantees: [{ kind: "email", email: "kola@example.test", role: "view" }],
        actor: owner(w),
      }),
    );
    const [, second] = await listAudit(w.t);
    expect(second.details).toMatchObject({
      addedCount: 1,
      removedCount: 1,
      added: `email:${sha256("kola@example.test")}:view`,
      removed: `group:${w.leads}:view`,
    });
  });

  test("a refused change writes no audit row: the cap, an editor, and a group of another workspace", async () => {
    const w = await world();
    const emails = Array.from({ length: 101 }, (_, i) => ({ kind: "email" as const, email: `user${i}@example.test`, role: "view" as const }));
    expect(
      await w.t.run(async (ctx) => setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "private", grantees: emails, actor: owner(w) })),
    ).toEqual({ ok: false, code: "INVALID" });
    expect(
      await w.t.run(async (ctx) =>
        setAccessRow(ctx as MutationCtx, {
          workspaceId: w.ws,
          path: "1-projects/plan.md",
          base: "private",
          grantees: [{ kind: "email", email: "a@example.test", role: "view" }],
          actor: { userId: w.editor, role: "editor" },
        }),
      ),
    ).toEqual({ ok: false, code: "FORBIDDEN" });
    const other = await w.t.run(async (ctx) => {
      const beta = await ctx.db.insert("workspaces", { slug: "beta", displayName: "beta", createdBy: w.owner, kind: "shared", structureTemplate: "para", createdAt: 1, updatedAt: 1 });
      return await ctx.db.insert("workspaceGroups", { workspaceId: beta, name: "beta-team", createdBy: w.owner, createdAt: 1 });
    });
    expect(
      await w.t.run(async (ctx) =>
        setAccessRow(ctx as MutationCtx, {
          workspaceId: w.ws,
          path: "1-projects/plan.md",
          base: "private",
          grantees: [{ kind: "group", groupId: other, role: "view" }],
          actor: owner(w),
        }),
      ),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await listAudit(w.t)).toHaveLength(0);
    expect(await grantsOn(w.t, w.ws, "1-projects/plan.md")).toHaveLength(0);
  });

  test("a base-only change writes no list audit row", async () => {
    const w = await world();
    await w.t.run(async (ctx) => setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: "1-projects/plan.md", base: "team", actor: owner(w) }));
    expect(await listAudit(w.t)).toHaveLength(0);
  });
});
