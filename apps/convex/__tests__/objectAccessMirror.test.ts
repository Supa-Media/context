/**
 * Convex written behind a workspace object's access write (`functions/objectAccessMirror.ts` `access`, the op
 * `access` of `POST /gateway/rows/mirror`, `functions/lib/gatewayRoutes/rowsMirror.ts`).
 *
 * Sabotage, run by hand: build `access` with the plain rowWatch `internalMutation`, and the outbox case fails; drop the
 * `bad_grantee` check, and the bad-user cases write a grant instead of refusing.
 */

import { describe, expect, test } from "vitest";
import { getFunctionName } from "convex/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { gatewayRowsMirrorHandler } from "../functions/lib/gatewayRoutes/rowsMirror";
import { nodeAt } from "../functions/lib/nodes/paths";
import { convexTest } from "convex-test";
import schema from "../schema";
import { modules } from "../test.setup";
import { parentRows } from "./nodes/treeRows.helpers";
import { gatewayPost } from "./fixtures.helpers";

type T = ReturnType<typeof makeTest>;
const makeTest = () => convexTest(schema, modules);

const PLAN = "1-projects/plan.md";
const GROUP_VIEW = "1-projects/group.md";

interface World {
  t: T;
  ws: Id<"workspaces">;
  other: Id<"workspaces">;
  owner: Id<"users">;
  leads: Id<"workspaceGroups">;
}

/** A shared workspace with an owner, a group, and two notes under `1-projects`, and no access state yet. */
async function world(): Promise<World> {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { email: "owner@example.test", emailVerificationTime: now } as never);
    const shared = (slug: string) =>
      ctx.db.insert("workspaces", {
        slug,
        displayName: slug,
        createdBy: owner,
        kind: "shared",
        structureTemplate: "para",
        createdAt: now,
        updatedAt: now,
      });
    const ws = await shared("acme");
    const other = await shared("beta");
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: owner, role: "owner", joinedAt: now });
    const leads = await ctx.db.insert("workspaceGroups", { workspaceId: ws, name: "acme-leads", createdBy: owner, createdAt: now });
    for (const path of ["1-projects", PLAN, GROUP_VIEW]) {
      await ctx.db.insert("nodes", {
        workspaceId: ws,
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        kind: path.endsWith(".md") ? "file" : "folder",
        observedAt: 1,
      });
    }
    await parentRows(ctx, ws);
    return { ws, other, owner, leads };
  });
  return { t, ...ids };
}

const rowOf = (t: T, ws: Id<"workspaces">, path: string) => t.run((ctx) => nodeAt(ctx.db, ws, path));

async function rowIdOf(t: T, ws: Id<"workspaces">, path: string): Promise<string> {
  const row = await rowOf(t, ws, path);
  if (row === null) throw new Error(`no row at ${path}`);
  return row._id;
}

async function stateOf(t: T, ws: Id<"workspaces">) {
  return await t.run(async (ctx) =>
    await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", ws))
      .unique(),
  );
}

async function grantsOn(t: T, ws: Id<"workspaces">, path: string) {
  const row = await rowOf(t, ws, path);
  if (row === null) throw new Error(`no row at ${path}`);
  return await t.run(async (ctx) =>
    await ctx.db
      .query("nodeAccess")
      .withIndex("by_node", (q) => q.eq("nodeId", row._id))
      .collect(),
  );
}

const auditOf = (t: T, action: string) => t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((event) => event.action === action));
const outbox = (t: T) => t.run(async (ctx) => await ctx.db.query("workspaceObjectOutbox").collect());

/** The object's copy of the workspace is at `version`: Convex holds the same access state the object does. */
async function seedState(t: T, ws: Id<"workspaces">, version: number) {
  await t.run((ctx) => ctx.db.insert("nodeAccessState", { workspaceId: ws, version, orphans: [], pending: [] }));
}

/** Marks `ws` as an object-home workspace, as the flip does (after the setup writes, which are not the mirror's). */
async function objectHome(t: T, ws: Id<"workspaces">) {
  await t.run((ctx) => ctx.db.insert("workspaceObjectHomes", { workspaceId: ws, home: "object", since: 0 }));
}

type AccessRecord = {
  rowId: string;
  noteId: string | null;
  path: string;
  kind: "file" | "folder";
  base: "private" | "team" | null;
  grantees: { kind: "user" | "group" | "email" | "members" | "accounts"; id: string; role: "view" | "edit" }[];
  baseChanged: boolean;
  listChanged: boolean;
  added: AccessRecord["grantees"];
  removed: AccessRecord["grantees"];
  baseVersion: number;
  version: number;
  actorUserId?: string;
  clientId?: string;
};

type Grantee = AccessRecord["grantees"][number];

/** A record the object would send for `PLAN` (`accessWrite.js` `change.record`). */
function recordFor(rowId: string, extra: Partial<AccessRecord> = {}): AccessRecord {
  const grantees = extra.grantees ?? [];
  return {
    rowId,
    noteId: null,
    path: PLAN,
    kind: "file",
    base: "private",
    grantees,
    baseChanged: true,
    // A list named here is the object's change: every grantee in it added (`accessWrite.js` `added`).
    listChanged: extra.grantees !== undefined,
    added: grantees,
    removed: [],
    baseVersion: 3,
    version: 4,
    ...extra,
  };
}

describe("objectAccessMirror.access", () => {
  test("base private applies: the row takes it, the snapshot is rebuilt, the version is the object's, and no outbox opens", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    await objectHome(w.t, w.ws);
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.access, {
      workspaceId: w.ws,
      objectAt: 40,
      record: recordFor(await rowIdOf(w.t, w.ws, PLAN)),
    });
    expect(answer).toEqual({ applied: true });
    expect((await rowOf(w.t, w.ws, PLAN))?.access).toEqual({ base: "private" });
    expect((await rowOf(w.t, w.ws, PLAN))?.objectAt).toBe(40);
    const state = await stateOf(w.t, w.ws);
    expect(state?.version).toBe(4);
    expect(state?.snapshot).toBeDefined();
    expect(await outbox(w.t)).toEqual([]);
  });

  test("a base of null is inherit: the row's base clears, and the owner's list is replaced by the object's (none)", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const rowId = await rowIdOf(w.t, w.ws, PLAN);
    await w.t.run((ctx) => ctx.db.patch(rowId as Id<"nodes">, { access: { base: "team" } }));
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.access, {
      workspaceId: w.ws,
      objectAt: 41,
      record: recordFor(rowId, { base: null }),
    });
    expect(answer).toEqual({ applied: true });
    expect((await rowOf(w.t, w.ws, PLAN))?.access).toBeUndefined();
  });

  test("the grantee list is replaced by the object's, a user and an email, and one access.list audit row is written", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    await w.t.run(async (ctx) => {
      const row = await nodeAt(ctx.db, w.ws, PLAN);
      await ctx.db.insert("nodeAccess", {
        workspaceId: w.ws,
        nodeId: row!._id,
        granteeKind: "group",
        granteeGroupId: w.leads,
        role: "view",
        grantedBy: w.owner,
        at: 1,
        source: "owner",
      });
    });
    const grantees: Grantee[] = [
      { kind: "user", id: w.owner, role: "edit" },
      { kind: "email", id: "Guest@Example.TEST", role: "view" },
    ];
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.access, {
      workspaceId: w.ws,
      objectAt: 42,
      record: recordFor(await rowIdOf(w.t, w.ws, PLAN), {
        base: "team",
        grantees,
        // The object held the group's grant and took it off.
        removed: [{ kind: "group", id: w.leads, role: "view" }],
        actorUserId: w.owner,
        clientId: "client-x",
      }),
    });
    expect(answer).toEqual({ applied: true });
    expect((await rowOf(w.t, w.ws, PLAN))?.access).toEqual({ base: "team" });
    const grants = await grantsOn(w.t, w.ws, PLAN);
    expect(grants).toHaveLength(2);
    expect(grants).toContainEqual(expect.objectContaining({ granteeKind: "user", granteeUserId: w.owner, role: "edit", source: "owner", grantedBy: w.owner }));
    expect(grants).toContainEqual(expect.objectContaining({ granteeKind: "email", granteeEmail: "guest@example.test", role: "view", source: "owner" }));
    const audits = await auditOf(w.t, "access.list");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ workspaceId: w.ws, actorUserId: w.owner, actorClientId: "client-x", details: { addedCount: 2, removedCount: 1 } });
  });

  test("a tier change from an object behind Convex keeps the list as Convex holds it: a revoked grant is not brought back", async () => {
    const w = await world();
    // Convex is at 4: it took its own list change since the object's 3 (the group's grant taken off, say).
    await seedState(w.t, w.ws, 4);
    await w.t.run(async (ctx) => {
      const row = await nodeAt(ctx.db, w.ws, PLAN);
      await ctx.db.insert("nodeAccess", { workspaceId: w.ws, nodeId: row!._id, granteeKind: "email", granteeEmail: "kept@example.test", role: "view", grantedBy: w.owner, at: 1, source: "owner" });
    });
    // The object still held the group's grant and the email's, and changed only the base.
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.access, {
      workspaceId: w.ws,
      objectAt: 7,
      record: {
        ...recordFor(await rowIdOf(w.t, w.ws, PLAN), { base: "private", baseVersion: 3, version: 5 }),
        grantees: [{ kind: "group", id: w.leads, role: "view" }, { kind: "email", id: "kept@example.test", role: "view" }],
        listChanged: false,
        added: [],
        removed: [],
      },
    });
    expect(answer).toEqual({ applied: true });
    expect((await rowOf(w.t, w.ws, PLAN))?.access).toEqual({ base: "private" });
    const grants = await grantsOn(w.t, w.ws, PLAN);
    expect(grants.map((grant) => grant.granteeKind)).toEqual(["email"]);
  });

  test("Convex took its own access change: the version is one above the object's, and an access push is queued", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 4);
    await objectHome(w.t, w.ws);
    const answer = await w.t.mutation(internal.functions.objectAccessMirror.access, {
      workspaceId: w.ws,
      objectAt: 40,
      record: recordFor(await rowIdOf(w.t, w.ws, PLAN), { baseVersion: 3, version: 4 }),
    });
    expect(answer).toEqual({ applied: true });
    expect((await stateOf(w.t, w.ws))?.version).toBe(5);
    expect(await outbox(w.t)).toContainEqual(expect.objectContaining({ workspaceId: w.ws, access: true, nodeIds: [] }));
  });

  test("a missing row, or one in another workspace, answers no_row and writes nothing", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const gone = await w.t.run(async (ctx) => {
      const row = await nodeAt(ctx.db, w.ws, PLAN);
      await ctx.db.delete(row!._id);
      return row!._id;
    });
    const elsewhere = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert("nodes", { workspaceId: w.other, path: PLAN, name: "plan.md", kind: "file", observedAt: 1 });
      return id;
    });
    for (const rowId of [gone, elsewhere, "not-a-row-id!"]) {
      expect(
        await w.t.mutation(internal.functions.objectAccessMirror.access, {
          workspaceId: w.ws,
          objectAt: 40,
          record: recordFor(rowId, { grantees: [{ kind: "email", id: "guest@example.test", role: "view" }] as Grantee[] }),
        }),
      ).toEqual({ applied: false, reason: "no_row" });
    }
    expect((await stateOf(w.t, w.ws))?.version).toBe(3);
    expect(await auditOf(w.t, "access.list")).toEqual([]);
    expect(await w.t.run((ctx) => ctx.db.query("nodeAccess").collect())).toEqual([]);
  });

  test("a grantee that names no real user is bad_grantee, and nothing is written, not even the grantees that were fine", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const rowId = await rowIdOf(w.t, w.ws, PLAN);
    const grantees: Grantee[] = [
      { kind: "email", id: "guest@example.test", role: "view" },
      { kind: "user", id: "not a valid id!", role: "view" },
    ];
    expect(
      await w.t.mutation(internal.functions.objectAccessMirror.access, {
        workspaceId: w.ws,
        objectAt: 40,
        record: recordFor(rowId, { base: "team", grantees }),
      }),
    ).toEqual({ applied: false, reason: "bad_grantee" });
    expect((await rowOf(w.t, w.ws, PLAN))?.access).toBeUndefined();
    expect(await grantsOn(w.t, w.ws, PLAN)).toEqual([]);
    expect((await stateOf(w.t, w.ws))?.version).toBe(3);
    expect(await auditOf(w.t, "access.list")).toEqual([]);
  });

  test("accounts outside the pinned workspace, or at an edit role, are bad_grantee: a sign-up never gains a note", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const rowId = await rowIdOf(w.t, w.ws, PLAN);
    for (const grantee of [
      { kind: "accounts", id: "accounts", role: "view" },
      { kind: "accounts", id: "accounts", role: "edit" },
    ] as Grantee[]) {
      expect(
        await w.t.mutation(internal.functions.objectAccessMirror.access, {
          workspaceId: w.ws,
          objectAt: 40,
          record: recordFor(rowId, { base: "team", grantees: [grantee] }),
        }),
      ).toEqual({ applied: false, reason: "bad_grantee" });
    }
    expect(await grantsOn(w.t, w.ws, PLAN)).toEqual([]);
  });

  test("an actor id that names no user is bad_actor, and nothing is written", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    expect(
      await w.t.mutation(internal.functions.objectAccessMirror.access, {
        workspaceId: w.ws,
        objectAt: 40,
        record: recordFor(await rowIdOf(w.t, w.ws, PLAN), { base: "team", actorUserId: "nobody!" }),
      }),
    ).toEqual({ applied: false, reason: "bad_actor" });
    expect((await rowOf(w.t, w.ws, PLAN))?.access).toBeUndefined();
  });
});

describe("POST /gateway/rows/mirror, op access", () => {
  test("routes access to the mirror: applied, skipped by reason, and a bad shape is a bad change", async () => {
    const w = await world();
    await seedState(w.t, w.ws, 3);
    const rowId = await rowIdOf(w.t, w.ws, PLAN);
    const response = await gatewayPost(w.t, "/gateway/rows/mirror", {
      workspaceId: w.ws,
      changes: [
        { seq: 1, op: "access", objectAt: 40, record: recordFor(rowId, { base: "team" }) },
        { seq: 2, op: "access", objectAt: 41, record: recordFor(rowId, { base: "private", grantees: [{ kind: "user", id: "bad id!", role: "view" }] as Grantee[] }) },
        { seq: 3, op: "access", objectAt: 42, record: { rowId, path: PLAN } },
        { seq: 4, op: "toString", objectAt: 43, record: {} },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      applied: [1],
      skipped: [
        { seq: 2, reason: "bad_grantee" },
        { seq: 3, reason: "bad change" },
        { seq: 4, reason: "unknown op" },
      ],
    });
    expect((await rowOf(w.t, w.ws, PLAN))?.access).toEqual({ base: "team" });
    expect((await stateOf(w.t, w.ws))?.version).toBe(4);
  });

  test("the handler passes access to the mirror mutation by name", async () => {
    const names: string[] = [];
    const ctx = {
      runMutation: async (ref: Parameters<typeof getFunctionName>[0]) => {
        names.push(getFunctionName(ref));
        return { applied: true };
      },
    };
    const response = await gatewayRowsMirrorHandler(ctx as never, {
      workspaceId: "ws-access",
      changes: [{ seq: 1, op: "access", objectAt: 1, record: {} }],
    });
    expect(await response.json()).toEqual({ applied: [1], skipped: [] });
    expect(names).toHaveLength(1);
    expect(names).toEqual(["functions/objectAccessMirror:access"]);
  });
});
