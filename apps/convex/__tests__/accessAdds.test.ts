/**
 * Joins and invitations at a workspace whose members and invites are decided in its object
 * (`functions/lib/accessHandOff/adds.ts`, `flush.ts`, `functions/accessObjectPush.ts`; decided by the owner, 2026-11-01:
 * `docs/decisions/identity-and-access/access-in-objects.md`).
 *
 * Covers: `addsOf` on hand-built writes (which writes are joins or invitations, and which take access away or change it);
 * at `object`, a join, an invitation and its revocation are let through and queued as `adds`, while a role change or a
 * removal is refused and queues nothing; at `dual`, a join queues the whole members table and no `adds`; the push puts
 * each join and invitation row in the object (`members.put`, `invites.put`, `invites.remove`), with the invitation's
 * token only as its hash; a join deleted before the push is not put; a refused round keeps its entries for the next;
 * a switch back to `dual` sends whole tables instead; the real invitation accept and domain join queue their adds.
 *
 * Sabotage, each confirmed to fail a case here: let a member role patch or delete through `addsOf`; allow any user's
 * group-row delete; put a member Convex no longer holds; ignore a refused `members.put`; never queue adds (refuse joins).
 *
 * Every value is fake (example.com). The object is a fake recording every call; the door is a fake recording whole-table writes.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { addsOf } from "../functions/lib/accessHandOff/adds";
import { flushAccessWrites, WORKSPACE_SWITCHED } from "../functions/lib/accessHandOff/flush";
import type { AccessWrite } from "../functions/lib/accessHandOff/record";
import { watchDb } from "../functions/lib/rowWatch/watch";
import { drainOnce, type AddsObject, type OpenAdds, type PushDoor } from "../functions/accessObjectPush";
import type { AccessDoor } from "../functions/lib/accessObjects/door";
import { asUser, createUser, createWorkspace, errorCode, pendingInvitationToken, setupTest, type TestConvex } from "./fixtures.helpers";

type Home = "convex" | "dual" | "object";
const DAY = 86_400_000;
const RAW_TOKEN = "raw-invite-token-example-not-real";

async function world() {
  const t = setupTest();
  const owner = await createUser(t, "adds-owner@example.com");
  const ownerPersonal = await createWorkspace(t, owner, "adds-owner");
  const shared = await createWorkspace(t, owner, "adds-shared", { kind: "shared" });
  const guest = await createUser(t, "adds-guest@example.com");
  const guestPersonal = await createWorkspace(t, guest, "adds-guest");
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

/** Run `write` against the wrapped database, flush its access writes, and return what `write` returned. */
async function watched<T>(t: TestConvex, write: (db: MutationCtx["db"]) => Promise<T>, writeBehind = false): Promise<T> {
  return await t.run(async (ctx) => {
    const watch = watchDb(ctx.db);
    const result = await write(watch.db);
    await flushAccessWrites({ ...ctx, db: watch.db }, watch.accessWrites, { writeBehind });
    return result;
  });
}

async function outbox(t: TestConvex) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("accessObjectOutbox").collect()).map((entry) => ({ workspaceId: entry.workspaceId, tables: entry.tables, adds: entry.adds })),
  );
}

const join = (db: MutationCtx["db"], workspaceId: Id<"workspaces">, userId: Id<"users">) =>
  db.insert("workspaceMembers", { workspaceId, userId, role: "member", joinedAt: 1 });

function inviteDoc(workspaceId: Id<"workspaces">, invitedBy: Id<"users">, invitee: string) {
  return {
    workspaceId,
    inviteeKind: "email" as const,
    invitee,
    role: "member" as const,
    invitedBy,
    token: RAW_TOKEN,
    status: "pending" as const,
    expiresAt: Date.now() + DAY,
    createdAt: Date.now(),
  };
}

/** A door that records every whole-table write, as `accessObjectPush.ts` sends them on `dual`. */
function fakeDoor() {
  const writes: Array<{ table: string; rows: number }> = [];
  const open: PushDoor = () =>
    ({
      table: (table: string) => ({
        async snapshot({ rows }: { rows: unknown[] }) {
          writes.push({ table, rows: rows.length });
          return {};
        },
        async digest() {
          return { count: 0, sha: "" };
        },
      }),
      async setHome() {},
    }) as unknown as AccessDoor;
  return { open, writes };
}

/** The gateway's members and invites client: records each call, and answers `{ error }` for all of them while refusing. */
function fakeAdds() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  let refusing = false;
  const answer = (op: string, args: unknown[], ok: unknown) => {
    calls.push({ op, args });
    return refusing ? { error: "refused" } : ok;
  };
  const object: AddsObject = {
    members: { put: async (rows, extra) => answer("members.put", [rows, extra], { kept: rows.length }) },
    invites: {
      put: async (rows) => answer("invites.put", [rows], { kept: rows.length }),
      remove: async (ids, at) => answer("invites.remove", [ids, at], { removed: ids.length }),
    },
  };
  return { calls, refuse: (value: boolean) => (refusing = value), open: (() => object) as OpenAdds };
}

const callsOf = (adds: ReturnType<typeof fakeAdds>, op: string) => adds.calls.filter((call) => call.op === op);

/**
 * Each write schedules a drain of its own, with the real door; these tests drive the push with their fakes, so the
 * pending ones are cancelled first (a background drain would hold the lease and race the test's round).
 */
async function cancelScheduledPushes(t: TestConvex) {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) if (job.state.kind === "pending" && job.name.includes("accessObjectPush")) await ctx.scheduler.cancel(job._id);
  });
}

const drain = async (t: TestConvex, workspaceId: Id<"workspaces">, door: ReturnType<typeof fakeDoor>, adds: ReturnType<typeof fakeAdds>) => {
  await cancelScheduledPushes(t);
  return await t.action(async (ctx) => await drainOnce(ctx, workspaceId, door.open, adds.open));
};

describe("addsOf", () => {
  const W = "ws-1" as Id<"workspaces">;
  const inserted: AccessWrite = { table: "workspaceMembers", id: "m-1", op: "insert", doc: { workspaceId: "ws-1", userId: "u-1", role: "member" } };
  const invite = { table: "workspaceInvitations", id: "i-1", doc: { workspaceId: "ws-1", status: "pending" } } as const;
  const joinerGroupRow: AccessWrite = { table: "workspaceGroupMembers", id: "gm-1", op: "before", doc: { workspaceId: "ws-1", userId: "u-1", groupId: "g-1" } };

  test("a member insert gives its userId", () => {
    expect(addsOf([inserted], W)).toEqual({ userIds: ["u-1"], inviteIds: [] });
  });

  test("an invitation insert, patch or delete gives its id", () => {
    expect(addsOf([{ ...invite, op: "insert" }], W)).toEqual({ userIds: [], inviteIds: ["i-1"] });
    expect(
      addsOf(
        [
          { ...invite, op: "before" },
          { ...invite, op: "after", doc: { workspaceId: "ws-1", status: "revoked" } },
        ],
        W,
      ),
    ).toEqual({ userIds: [], inviteIds: ["i-1"] });
    expect(addsOf([{ ...invite, op: "before" }], W)).toEqual({ userIds: [], inviteIds: ["i-1"] });
  });

  test("a member role patch gives null, and so does a member delete", () => {
    const before: AccessWrite = { table: "workspaceMembers", id: "m-2", op: "before", doc: { workspaceId: "ws-1", userId: "u-2", role: "member" } };
    expect(addsOf([before, { ...before, op: "after", doc: { workspaceId: "ws-1", userId: "u-2", role: "editor" } }], W)).toBeNull();
    expect(addsOf([before], W)).toBeNull();
  });

  test("a group-row delete is allowed only for the user joining in the same writes", () => {
    expect(addsOf([inserted, joinerGroupRow], W)).toEqual({ userIds: ["u-1"], inviteIds: [] });
    expect(addsOf([inserted, { ...joinerGroupRow, doc: { workspaceId: "ws-1", userId: "u-9", groupId: "g-1" } }], W)).toBeNull();
  });

  test("a new group names nobody and passes; changing or deleting a group gives null", () => {
    expect(addsOf([{ table: "workspaceGroups", id: "g-1", op: "insert", doc: { workspaceId: "ws-1", name: "crew" } }], W)).toEqual({ userIds: [], inviteIds: [] });
    expect(addsOf([inserted, { table: "workspaceGroups", id: "g-1", op: "before", doc: { workspaceId: "ws-1", name: "crew" } }], W)).toBeNull();
  });

  test("writes for another workspace are ignored", () => {
    const otherRolePatch: AccessWrite = { table: "workspaceMembers", id: "m-3", op: "before", doc: { workspaceId: "ws-2", userId: "u-3", role: "member" } };
    const otherGroupDelete: AccessWrite = { table: "workspaceGroupMembers", id: "gm-3", op: "before", doc: { workspaceId: "ws-2", userId: "u-3", groupId: "g-2" } };
    expect(addsOf([otherRolePatch, otherGroupDelete], W)).toEqual({ userIds: [], inviteIds: [] });
  });
});

describe("at object", () => {
  test("a join is let through and queued as adds, with no tables", async () => {
    const { t, shared, guest } = await world();
    await setHomes(t, shared, { access: "object" });
    await watched(t, (db) => join(db, shared, guest));
    expect(await outbox(t)).toEqual([{ workspaceId: shared, tables: [], adds: { userIds: [guest], inviteIds: [] } }]);
  });

  test("an invitation is queued as adds, and so is its revocation", async () => {
    const { t, owner, shared } = await world();
    await setHomes(t, shared, { access: "object" });
    const inviteId = await watched(t, (db) => db.insert("workspaceInvitations", inviteDoc(shared, owner, "adds-invitee@example.com")));
    expect(await outbox(t)).toEqual([{ workspaceId: shared, tables: [], adds: { userIds: [], inviteIds: [inviteId] } }]);

    await watched(t, (db) => db.patch(inviteId, { status: "revoked", respondedAt: 2 }));
    expect((await outbox(t)).map((entry) => entry.adds)).toEqual([
      { userIds: [], inviteIds: [inviteId] },
      { userIds: [], inviteIds: [inviteId] },
    ]);
  });

  test("a role change and a removal are refused, and queue nothing", async () => {
    const { t, shared, guest } = await world();
    const memberId = await t.run((ctx) => ctx.db.insert("workspaceMembers", { workspaceId: shared, userId: guest, role: "member", joinedAt: 1 }));
    await setHomes(t, shared, { access: "object" });

    const patched = await watched(t, (db) => db.patch(memberId, { role: "editor" })).catch((error) => error);
    expect(errorCode(patched)).toBe(WORKSPACE_SWITCHED);
    const deleted = await watched(t, (db) => db.delete(memberId)).catch((error) => error);
    expect(errorCode(deleted)).toBe(WORKSPACE_SWITCHED);
    expect(await t.run((ctx) => ctx.db.get(memberId))).not.toBeNull();
    expect(await outbox(t)).toEqual([]);
  });
});

describe("at dual", () => {
  test("a join queues the whole members table and no adds", async () => {
    const { t, shared, guest } = await world();
    await setHomes(t, shared, { access: "dual" });
    await watched(t, (db) => join(db, shared, guest));
    const [entry] = await outbox(t);
    expect(entry).toMatchObject({ workspaceId: shared, tables: ["members"] });
    expect(entry.adds).toBeUndefined();
  });
});

describe("drainOnce carries the adds to the object", () => {
  test("a join is put as one member row, with the workspace's name and kind, and the outbox empties", async () => {
    const { t, shared, guest, guestPersonal } = await world();
    await setHomes(t, shared, { access: "object" });
    await watched(t, (db) => join(db, shared, guest));
    const adds = fakeAdds();
    expect(await drain(t, shared, fakeDoor(), adds)).toBe("done");

    const puts = callsOf(adds, "members.put");
    expect(puts).toHaveLength(1);
    const [rows, extra] = puts[0].args as [Array<Record<string, unknown>>, unknown];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: guest, personalWorkspaceId: guestPersonal, role: "member" });
    expect(extra).toEqual({ workspace: { slug: "adds-shared", kind: "shared" } });
    expect(await outbox(t)).toEqual([]);
  });

  test("an invitation is put with its id and its token only as a hash", async () => {
    const { t, owner, shared } = await world();
    await setHomes(t, shared, { access: "object" });
    const inviteId = await watched(t, (db) => db.insert("workspaceInvitations", inviteDoc(shared, owner, "adds-invitee@example.com")));
    const adds = fakeAdds();
    expect(await drain(t, shared, fakeDoor(), adds)).toBe("done");

    const puts = callsOf(adds, "invites.put");
    expect(puts).toHaveLength(1);
    const [rows] = puts[0].args as [Array<Record<string, unknown>>];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: inviteId, email: "adds-invitee@example.com", role: "member" });
    expect(String(rows[0].tokenHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(RAW_TOKEN);
  });

  test("a revoked invitation is removed by id", async () => {
    const { t, owner, shared } = await world();
    await setHomes(t, shared, { access: "object" });
    const inviteId = await watched(t, (db) => db.insert("workspaceInvitations", inviteDoc(shared, owner, "adds-invitee@example.com")));
    expect(await drain(t, shared, fakeDoor(), fakeAdds())).toBe("done");

    await watched(t, (db) => db.patch(inviteId, { status: "revoked", respondedAt: 2 }));
    const adds = fakeAdds();
    expect(await drain(t, shared, fakeDoor(), adds)).toBe("done");
    expect(callsOf(adds, "invites.put")).toEqual([]);
    const removes = callsOf(adds, "invites.remove");
    expect(removes).toHaveLength(1);
    expect(removes[0].args[0]).toEqual([inviteId]);
  });

  test("a join deleted before the push is never put", async () => {
    const { t, shared, guest } = await world();
    await setHomes(t, shared, { access: "object" });
    const memberId = await watched(t, (db) => join(db, shared, guest));
    await watched(t, (db) => db.delete(memberId), true);
    const adds = fakeAdds();
    expect(await drain(t, shared, fakeDoor(), adds)).toBe("done");
    expect(callsOf(adds, "members.put")).toEqual([]);
    expect(await outbox(t)).toEqual([]);
  });

  test("a refused round keeps its entries, and the next round puts them", async () => {
    const { t, shared, guest } = await world();
    await setHomes(t, shared, { access: "object" });
    await watched(t, (db) => join(db, shared, guest));
    const adds = fakeAdds();

    adds.refuse(true);
    expect(await drain(t, shared, fakeDoor(), adds)).toBe("failed");
    expect(await outbox(t)).toHaveLength(1);

    adds.refuse(false);
    expect(await drain(t, shared, fakeDoor(), adds)).toBe("done");
    expect(await outbox(t)).toEqual([]);
    expect(callsOf(adds, "members.put")).toHaveLength(2);
  });

  test("switched back to dual before the push, it sends the members table whole and calls no adds", async () => {
    const { t, shared, guest } = await world();
    await setHomes(t, shared, { access: "object" });
    await watched(t, (db) => join(db, shared, guest));
    await setHomes(t, shared, { access: "dual" });
    const door = fakeDoor();
    const adds = fakeAdds();
    expect(await drain(t, shared, door, adds)).toBe("done");
    expect(door.writes).toEqual([{ table: "members", rows: 2 }]);
    expect(adds.calls).toEqual([]);
  });
});

describe("through real mutations", () => {
  test("accepting an invitation at object queues the joiner and the accepted invitation, and the push puts both", async () => {
    const { t, owner, shared, guest } = await world();
    await setHomes(t, shared, { access: "object" });
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, { workspaceId: shared, invitee: "adds-guest@example.com", role: "member" });
    const adds = fakeAdds();
    expect(await drain(t, shared, fakeDoor(), adds)).toBe("done");
    const [[putRows]] = callsOf(adds, "invites.put").map((call) => call.args as [Array<{ id: string }>]);
    const inviteId = putRows[0].id;

    const token = await pendingInvitationToken(t, guest, shared);
    expect(token).not.toBeNull();
    await asUser(t, guest).mutation(api.functions.invitations.acceptInvitation, { token: token! });
    const queued = await outbox(t);
    expect(queued).toEqual([{ workspaceId: shared, tables: [], adds: { userIds: [guest], inviteIds: [inviteId] } }]);

    const second = fakeAdds();
    expect(await drain(t, shared, fakeDoor(), second)).toBe("done");
    expect(callsOf(second, "members.put")).toHaveLength(1);
    expect(callsOf(second, "invites.remove")[0].args[0]).toEqual([inviteId]);
  });

  test("joining by an opened domain at object succeeds and queues the joiner", async () => {
    const { t, owner, shared, guest } = await world();
    await asUser(t, owner).mutation(api.functions.workspaceDomains.addWorkspaceDomain, { workspaceId: shared, domain: "example.com" });
    await setHomes(t, shared, { access: "object" });
    const joined = await asUser(t, guest).mutation(api.functions.workspaceDomains.joinWithDomain, { slug: "adds-shared" });
    expect(joined).toMatchObject({ slug: "adds-shared", domain: "example.com", role: "member" });
    expect(await outbox(t)).toEqual([{ workspaceId: shared, tables: [], adds: { userIds: [guest], inviteIds: [] } }]);
  });
});
