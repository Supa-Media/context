/**
 * Convex's access writes hand off to the objects (`lib/accessHandOff/`, `functions/accessObjectPush.ts`; decided by
 * the owner, 2026-11-01: `docs/decisions/identity-and-access/access-in-objects.md`).
 *
 * - `convex`: nothing happens beyond the write.
 * - `dual`: every change leaves an outbox entry naming its object and tables, and the push sends those tables whole.
 * - `object`: a Convex write to a table the object is the authority for is refused, unless written behind it.
 *
 * Sabotage, each confirmed to fail a case here: drop `flushAccessWrites` from the wrapper; treat every scope as the
 * workspace's (a person on `object` keeps taking Convex connection writes); let a volatile patch count (every
 * `touchGrant` is refused once switched); send authority tables to an object on `object` (Convex's older copy
 * overwrites the authority); ack before the object took the round (a failed push loses the change).
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { watchDb } from "../functions/lib/rowWatch/watch";
import { flushAccessWrites, WORKSPACE_SWITCHED } from "../functions/lib/accessHandOff/flush";
import { targetsOf } from "../functions/lib/accessHandOff/record";
import { drainOnce, type PushDoor } from "../functions/accessObjectPush";
import type { AccessDoor } from "../functions/lib/accessObjects/door";
import { asUser, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";

type Home = "convex" | "dual" | "object";

async function world() {
  const t = setupTest();
  const owner = await createUser(t, "hand-off-owner@example.com");
  const ownerPersonal = await createWorkspace(t, owner, "hand-off-owner");
  const shared = await createWorkspace(t, owner, "hand-off-shared", { kind: "shared" });
  const guest = await createUser(t, "hand-off-guest@example.com");
  const guestPersonal = await createWorkspace(t, guest, "hand-off-guest");
  return { t, owner, ownerPersonal, shared, guest, guestPersonal };
}

async function setHomes(t: TestConvex, workspaceId: Id<"workspaces">, homes: { access?: Home; personAccess?: Home }) {
  await t.run(async (ctx) => {
    const held = await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (held === null) await ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "bucket", since: 0, ...homes });
    else await ctx.db.patch(held._id, homes);
  });
}

/** Run `write` against the wrapped database and flush its access writes, as every mutation in the deployment does. */
async function watched(t: TestConvex, write: (db: MutationCtx["db"]) => Promise<unknown>, writeBehind = false) {
  return await t.run(async (ctx) => {
    const watch = watchDb(ctx.db);
    await write(watch.db);
    await flushAccessWrites({ ...ctx, db: watch.db }, watch.accessWrites, { writeBehind });
  });
}

async function outbox(t: TestConvex) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("accessObjectOutbox").collect()).map((entry) => ({ workspaceId: entry.workspaceId, tables: entry.tables })),
  );
}

async function grant(t: TestConvex, workspaceId: Id<"workspaces">, userId: Id<"users">, clientId = "claude") {
  return await t.run((ctx) =>
    ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId,
      scopes: ["context.read"],
      hashedRefreshToken: "a".repeat(64),
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

describe("which object a write lands in", () => {
  test("a membership changes its workspace's members and its person's reach; a group chat's grant reaches nobody", () => {
    expect(targetsOf({ table: "workspaceMembers", doc: { workspaceId: "w", userId: "u" } }).map((target) => target.table)).toEqual(["members", "reach"]);
    expect(targetsOf({ table: "oauthGrants", doc: { userId: "u", clientId: "claude" } })).toEqual([{ kind: "person", userId: "u", table: "connections" }]);
    expect(targetsOf({ table: "oauthGrants", doc: { userId: "u", clientId: "claude", texGroup: {} } })).toEqual([]);
    expect(targetsOf({ table: "oauthGrants", doc: { userId: "u", clientId: "context_texts" } })).toEqual([]);
    expect(targetsOf({ table: "nodeAccess", doc: { granteeKind: "members", workspaceId: "w" } })).toEqual([]);
  });
});

describe("on convex", () => {
  test("a new member leaves no entry", async () => {
    const { t, shared, guest } = await world();
    await watched(t, (db) => db.insert("workspaceMembers", { workspaceId: shared, userId: guest, role: "member", joinedAt: 1 }));
    expect(await outbox(t)).toEqual([]);
  });
});

describe("on dual", () => {
  test("a new member is queued for the workspace's members and, on its own switch, the person's reach", async () => {
    const { t, shared, guest, guestPersonal } = await world();
    await setHomes(t, shared, { access: "dual" });
    await watched(t, (db) => db.insert("workspaceMembers", { workspaceId: shared, userId: guest, role: "member", joinedAt: 1 }));
    expect(await outbox(t)).toEqual([{ workspaceId: shared, tables: ["members"] }]);

    await setHomes(t, guestPersonal, { personAccess: "dual" });
    await watched(t, async (db) => {
      const row = await db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", shared).eq("userId", guest))
        .unique();
      await db.patch(row!._id, { role: "editor" });
    });
    expect((await outbox(t)).slice(1).sort((a, b) => String(a.workspaceId).localeCompare(String(b.workspaceId)))).toEqual(
      [
        { workspaceId: shared, tables: ["members"] },
        { workspaceId: guestPersonal, tables: ["reach"] },
      ].sort((a, b) => String(a.workspaceId).localeCompare(String(b.workspaceId))),
    );
  });

  test("a connection is queued for its person's own object, whatever workspace it reaches", async () => {
    const { t, shared, guest, guestPersonal } = await world();
    await setHomes(t, guestPersonal, { personAccess: "dual" });
    await watched(t, (db) =>
      db.insert("oauthGrants", { workspaceId: shared, userId: guest, clientId: "claude", scopes: [], hashedRefreshToken: "b".repeat(64), status: "active", createdAt: 1 }),
    );
    expect(await outbox(t)).toEqual([{ workspaceId: guestPersonal, tables: ["connections"] }]);
  });

  test("a grant touched on use is not a change", async () => {
    const { t, shared, guest, guestPersonal } = await world();
    const grantId = await grant(t, shared, guest);
    await setHomes(t, guestPersonal, { personAccess: "dual" });
    await watched(t, (db) => db.patch(grantId, { lastUsedAt: 5 }));
    expect(await outbox(t)).toEqual([]);
  });
});

describe("on object", () => {
  test("a Convex write to members is refused; written behind the object it goes through and is not sent back", async () => {
    const { t, shared, guest } = await world();
    await setHomes(t, shared, { access: "object" });
    const refused = await watched(t, (db) => db.insert("workspaceMembers", { workspaceId: shared, userId: guest, role: "member", joinedAt: 1 })).catch((error) => error);
    expect(errorCode(refused)).toBe(WORKSPACE_SWITCHED);
    expect(await t.run((ctx) => ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", shared).eq("userId", guest)).unique())).toBeNull();

    await watched(t, (db) => db.insert("workspaceMembers", { workspaceId: shared, userId: guest, role: "member", joinedAt: 1 }), true);
    expect(await outbox(t)).toEqual([]);
  });

  test("a person on object refuses a Convex connection, while their workspace's members (on its own switch) still flow", async () => {
    const { t, shared, guest, guestPersonal } = await world();
    await setHomes(t, guestPersonal, { personAccess: "object" });
    const refused = await watched(t, (db) =>
      db.insert("oauthGrants", { workspaceId: shared, userId: guest, clientId: "claude", scopes: [], hashedRefreshToken: "c".repeat(64), status: "active", createdAt: 1 }),
    ).catch((error) => error);
    expect(errorCode(refused)).toBe(WORKSPACE_SWITCHED);

    // Reach is a copy: the shared workspace, still on dual, decides the membership, and the person's copy follows.
    await setHomes(t, shared, { access: "dual" });
    await watched(t, (db) => db.insert("workspaceMembers", { workspaceId: shared, userId: guest, role: "member", joinedAt: 1 }));
    expect((await outbox(t)).map((entry) => entry.tables).sort()).toEqual([["members"], ["reach"]]);
  });

  test("touching a grant and texting grants are never refused", async () => {
    const { t, shared, guest, guestPersonal } = await world();
    const grantId = await grant(t, shared, guest);
    await setHomes(t, guestPersonal, { personAccess: "object" });
    await watched(t, (db) => db.patch(grantId, { lastUsedAt: 5 }));
    await watched(t, (db) =>
      db.insert("oauthGrants", { workspaceId: shared, userId: guest, clientId: "context_texts", scopes: [], hashedRefreshToken: "d".repeat(64), status: "active", createdAt: 1 }),
    );
    expect(await outbox(t)).toEqual([]);
  });
});

/** A door that records every whole-table write, and can be made to fail. */
function fakeDoor() {
  const writes: Array<{ workspaceId: string; table: string; rows: number; epoch: number }> = [];
  let failing = false;
  const open: PushDoor = (workspaceId) =>
    ({
      table: (table) => ({
        async snapshot({ epoch, rows }) {
          if (failing) throw new Error("object down");
          writes.push({ workspaceId: String(workspaceId), table, rows: rows.length, epoch });
          return {};
        },
        async digest() {
          return { count: 0, sha: "" };
        },
      }),
      async setHome() {},
    }) as AccessDoor;
  return { open, writes, fail: (value: boolean) => (failing = value) };
}

describe("through a real mutation", () => {
  test("revoking a connection in the app is queued on dual and refused on object", async () => {
    const { t, ownerPersonal, owner } = await world();
    const first = await grant(t, ownerPersonal, owner);
    await setHomes(t, ownerPersonal, { personAccess: "dual" });
    await asUser(t, owner).mutation(api.functions.grants.revokeGrant, { grantId: first });
    expect(await outbox(t)).toEqual([{ workspaceId: ownerPersonal, tables: ["connections"] }]);

    const second = await grant(t, ownerPersonal, owner);
    await setHomes(t, ownerPersonal, { personAccess: "object" });
    const refused = await asUser(t, owner).mutation(api.functions.grants.revokeGrant, { grantId: second }).catch((error) => error);
    expect(errorCode(refused)).toBe(WORKSPACE_SWITCHED);
    expect((await t.run((ctx) => ctx.db.get(second)))?.status).toBe("active");
  });
});

describe("the push", () => {
  test("sends each named table whole, then empties the outbox; a failed round keeps its entries", async () => {
    const { t, shared, guest } = await world();
    await setHomes(t, shared, { access: "dual" });
    await watched(t, (db) => db.insert("workspaceMembers", { workspaceId: shared, userId: guest, role: "member", joinedAt: 1 }));
    const door = fakeDoor();

    door.fail(true);
    expect(await t.action(async (ctx) => await drainOnce(ctx, shared, door.open))).toBe("failed");
    expect(await outbox(t)).toHaveLength(1);

    door.fail(false);
    expect(await t.action(async (ctx) => await drainOnce(ctx, shared, door.open))).toBe("done");
    expect(door.writes.map(({ table, rows }) => ({ table, rows }))).toEqual([{ table: "members", rows: 2 }]);
    expect(await outbox(t)).toEqual([]);
  });

  test("sends a person's connections to their own object, under the person scope", async () => {
    const { t, guest, guestPersonal } = await world();
    await setHomes(t, guestPersonal, { personAccess: "dual" });
    await watched(t, (db) =>
      db.insert("oauthGrants", { workspaceId: guestPersonal, userId: guest, clientId: "claude", scopes: ["context.read"], hashedRefreshToken: "e".repeat(64), status: "active", createdAt: 1 }),
    );
    const door = fakeDoor();
    expect(await t.action(async (ctx) => await drainOnce(ctx, guestPersonal, door.open))).toBe("done");
    expect(door.writes.map(({ workspaceId, table, rows }) => ({ workspaceId, table, rows }))).toEqual([{ workspaceId: String(guestPersonal), table: "connections", rows: 1 }]);
  });

  test("never sends an authority table to an object that decides it", async () => {
    const { t, shared, guest } = await world();
    await setHomes(t, shared, { access: "dual" });
    await watched(t, (db) => db.insert("workspaceMembers", { workspaceId: shared, userId: guest, role: "member", joinedAt: 1 }));
    await setHomes(t, shared, { access: "object" });
    const door = fakeDoor();
    expect(await t.action(async (ctx) => await drainOnce(ctx, shared, door.open))).toBe("done");
    expect(door.writes).toEqual([]);
    expect(await outbox(t)).toEqual([]);
  });

  test("the drain is scheduled by the write itself", async () => {
    const { t, shared, guest } = await world();
    await setHomes(t, shared, { access: "dual" });
    await watched(t, (db) => db.insert("workspaceMembers", { workspaceId: shared, userId: guest, role: "member", joinedAt: 1 }));
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some((job) => job.name.includes("accessObjectPush") && job.name.includes("drain"))).toBe(true);
    void internal;
  });
});
