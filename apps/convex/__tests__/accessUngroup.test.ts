/**
 * Leaving, deleting and joining groups where a workspace's members are decided in its object
 * (`functions/groups.ts`, `functions/lib/accessHandOff/ungroup.ts`, `functions/accessTakeAway.ts`,
 * `functions/lib/textGroupGuestSync.ts`; decided by the owner, 2026-11-01:
 * `docs/decisions/identity-and-access/access-in-objects.md`).
 *
 * Covers: off `object`, leaving a group deletes its row at once and queues nothing; at `object`, leaving queues one
 * "ungroup" job and deletes nothing until the queue runs, and the run puts the leaving member's row without that group
 * (their other group kept); a refusing object leaves the row and the job for a retry; deleting a group at `object`
 * queues a whole-group job whose run puts every member without it, then deletes the group, its rows and its `names`
 * claim; a member who joins the group after the deletion was queued is put too, and the run goes round again; creating
 * an empty group and joining one at `object` are let through (the join is queued as `adds`); a `toolsListedAt` stamp on
 * a grant is never refused at a person on `object`, while a scope change on the same grant still is; deleting a
 * workspace with an ungroup job queued still queues its own deletion; a Tex chat guest leaving the chat's group
 * (`unsyncChatPeople`) queues the same ungroup job.
 *
 * Sabotage, each confirmed to fail a case here: never queue a leave at object; put the member's row with the group
 * still in it; skip the whole-group re-plan; drop `keepInGroup` from `addGroupMember`; make `toolsListedAt` matter;
 * let any queued job for the workspace stand for its deletion.
 *
 * Every value is fake (example.com). The object is a fake recording every call and every member row it is sent.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { runTakeAway, type OpenObject } from "../functions/accessTakeAway";
import { flushAccessWrites, WORKSPACE_SWITCHED } from "../functions/lib/accessHandOff/flush";
import { watchDb } from "../functions/lib/rowWatch/watch";
import { unsyncChatPeople } from "../functions/lib/textGroupGuestSync";
import { addMember, asUser, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";

type Mode = "working" | "refuse";
type Call = { workspaceId: string; op: string; keys: string[] };
type Put = { userId: string; groups: string[] };

/** The object's side of an ungroup: records every call and every member row put, and answers `{ error }` while refusing. */
function fakeObjects() {
  const calls: Call[] = [];
  const puts: Put[] = [];
  let mode: Mode = "working";
  const answer = (workspaceId: Id<"workspaces">, op: string, keys: string[], ok: unknown) => {
    calls.push({ workspaceId: String(workspaceId), op, keys });
    return mode === "refuse" ? { error: "refused" } : ok;
  };
  const open: OpenObject = (workspaceId) => ({
    members: {
      remove: async (userIds) => answer(workspaceId, "members.remove", userIds, { removed: userIds.length }),
      put: async (rows: unknown[]) => {
        const named = rows as Put[];
        const answered = answer(workspaceId, "members.put", named.map((row) => row.userId), { kept: named.length });
        if (mode === "working") puts.push(...named.map((row) => ({ userId: row.userId, groups: row.groups })));
        return answered;
      },
    },
    invites: { remove: async (ids) => answer(workspaceId, "invites.remove", ids, { removed: ids.length }) },
    access: {
      connections: { revoke: async (grantId) => answer(workspaceId, "connections.revoke", [grantId], { revoked: true }) },
    },
  });
  return { calls, puts, open, setMode: (next: Mode) => (mode = next) };
}

async function world() {
  const t = setupTest();
  const owner = await createUser(t, "ungroup-owner@example.com");
  const shared = await createWorkspace(t, owner, "ungroup-shared", { kind: "shared" });
  const guest = await createUser(t, "ungroup-guest@example.com");
  const guestPersonal = await createWorkspace(t, guest, "ungroup-guest");
  const editor = await createUser(t, "ungroup-editor@example.com");
  const editorPersonal = await createWorkspace(t, editor, "ungroup-editor");
  await addMember(t, shared, guest, "member", owner);
  await addMember(t, shared, editor, "editor", owner);
  return { t, owner, shared, guest, guestPersonal, editor, editorPersonal };
}

type World = Awaited<ReturnType<typeof world>>;

/** Upsert the workspace's home record, as `setAccess` leaves it. */
async function setHomes(t: TestConvex, workspaceId: Id<"workspaces">, homes: { access?: "dual" | "object"; personAccess?: "dual" | "object" }) {
  await t.run(async (ctx) => {
    const held = await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (held === null) await ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "bucket", since: 0, ...homes });
    else await ctx.db.patch(held._id, homes);
  });
}

const makeGroup = async (w: World, label: string) =>
  await asUser(w.t, w.owner).mutation(api.functions.groups.createGroup, { workspaceId: w.shared, label });
const joinGroup = async (w: World, groupId: Id<"workspaceGroups">, userId: Id<"users">) =>
  await asUser(w.t, w.owner).mutation(api.functions.groups.addGroupMember, { workspaceId: w.shared, groupId, userId });
const leaveGroup = async (w: World, groupId: Id<"workspaceGroups">, userId: Id<"users">) =>
  await asUser(w.t, w.owner).mutation(api.functions.groups.removeGroupMember, { workspaceId: w.shared, groupId, userId });

const queue = (t: TestConvex) => t.run((ctx) => ctx.db.query("accessTakeAways").collect());
const outbox = (t: TestConvex) => t.run((ctx) => ctx.db.query("accessObjectOutbox").collect());
const rowsOf = (t: TestConvex, groupId: Id<"workspaceGroups">) =>
  t.run((ctx) => ctx.db.query("workspaceGroupMembers").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect());
const claimOf = (t: TestConvex, name: string) =>
  t.run((ctx) => ctx.db.query("names").withIndex("by_name", (q) => q.eq("name", name)).unique());
const groupDoc = (t: TestConvex, groupId: Id<"workspaceGroups">) => t.run((ctx) => ctx.db.get(groupId));
const sorted = (ids: string[]) => [...ids].sort();

async function runQueued(t: TestConvex, id: Id<"accessTakeAways">, fake: ReturnType<typeof fakeObjects>) {
  return await t.action(async (ctx) => await runTakeAway(ctx, id, fake.open));
}

describe("leaving a group where the workspace is not on object", () => {
  test("Convex and dual delete the row at once and queue nothing", async () => {
    const w = await world();
    const crew = await makeGroup(w, "crew");
    await joinGroup(w, crew.groupId, w.guest);
    await leaveGroup(w, crew.groupId, w.guest);
    expect(await rowsOf(w.t, crew.groupId)).toEqual([]);
    expect(await queue(w.t)).toEqual([]);

    await setHomes(w.t, w.shared, { access: "dual" });
    await joinGroup(w, crew.groupId, w.guest);
    await leaveGroup(w, crew.groupId, w.guest);
    expect(await rowsOf(w.t, crew.groupId)).toEqual([]);
    expect(await queue(w.t)).toEqual([]);
  });
});

describe("leaving a group at object", () => {
  test("queues one ungroup job; the run puts the row without that group and keeps the other", async () => {
    const w = await world();
    const crew = await makeGroup(w, "crew");
    const readers = await makeGroup(w, "readers");
    await joinGroup(w, crew.groupId, w.guest);
    await joinGroup(w, readers.groupId, w.guest);
    await setHomes(w.t, w.shared, { access: "object" });

    await leaveGroup(w, crew.groupId, w.guest);
    const jobs = await queue(w.t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "ungroup", workspaceId: w.shared, groupId: crew.groupId, userIds: [w.guest] });
    expect(await rowsOf(w.t, crew.groupId)).toHaveLength(1);

    const fake = fakeObjects();
    expect(await runQueued(w.t, jobs[0]._id, fake)).toBe("done");
    expect(fake.puts).toEqual([{ userId: String(w.guest), groups: [readers.name] }]);
    expect(fake.calls).toEqual([{ workspaceId: String(w.shared), op: "members.put", keys: [String(w.guest)] }]);
    expect(await rowsOf(w.t, crew.groupId)).toEqual([]);
    expect(await rowsOf(w.t, readers.groupId)).toHaveLength(1);
    expect(await queue(w.t)).toEqual([]);
  });

  test("added back before the queued leave runs, the add wins: the row stays and goes to the object as it stands", async () => {
    const w = await world();
    const crew = await makeGroup(w, "crew");
    await joinGroup(w, crew.groupId, w.guest);
    await setHomes(w.t, w.shared, { access: "object" });

    await leaveGroup(w, crew.groupId, w.guest);
    await joinGroup(w, crew.groupId, w.guest);
    const [job] = await queue(w.t);
    expect(job.userIds).toEqual([]);
    expect((await outbox(w.t)).some((entry) => entry.adds?.userIds.includes(String(w.guest)))).toBe(true);

    expect(await runQueued(w.t, job._id, fakeObjects())).toBe("done");
    expect(await rowsOf(w.t, crew.groupId)).toHaveLength(1);
    expect(await queue(w.t)).toEqual([]);
  });

  test("a refusing object leaves the Convex row and the job; once it answers, the same leave completes", async () => {
    const w = await world();
    const crew = await makeGroup(w, "crew");
    await joinGroup(w, crew.groupId, w.guest);
    await setHomes(w.t, w.shared, { access: "object" });
    await leaveGroup(w, crew.groupId, w.guest);
    const [job] = await queue(w.t);

    const fake = fakeObjects();
    fake.setMode("refuse");
    expect(await runQueued(w.t, job._id, fake)).toBe("failed");
    expect(await rowsOf(w.t, crew.groupId)).toHaveLength(1);
    expect(await queue(w.t)).toEqual([job]);

    fake.setMode("working");
    expect(await runQueued(w.t, job._id, fake)).toBe("done");
    expect(await rowsOf(w.t, crew.groupId)).toEqual([]);
    expect(await queue(w.t)).toEqual([]);
  });
});

describe("deleting a group at object", () => {
  test("queues a whole-group job; the run puts every member without it, then deletes the group, its rows and its name", async () => {
    const w = await world();
    const crew = await makeGroup(w, "crew");
    const readers = await makeGroup(w, "readers");
    await joinGroup(w, crew.groupId, w.guest);
    await joinGroup(w, crew.groupId, w.editor);
    await joinGroup(w, readers.groupId, w.guest);
    await setHomes(w.t, w.shared, { access: "object" });

    await asUser(w.t, w.owner).mutation(api.functions.groups.deleteGroup, { workspaceId: w.shared, groupId: crew.groupId });
    expect(await groupDoc(w.t, crew.groupId)).not.toBeNull();
    const jobs = await queue(w.t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "ungroup", groupId: crew.groupId, wholeGroup: true });
    expect(sorted(jobs[0].userIds ?? [])).toEqual(sorted([String(w.guest), String(w.editor)]));

    const fake = fakeObjects();
    expect(await runQueued(w.t, jobs[0]._id, fake)).toBe("done");
    expect(fake.puts).toHaveLength(2);
    expect(fake.puts).toEqual(
      expect.arrayContaining([
        { userId: String(w.guest), groups: [readers.name] },
        { userId: String(w.editor), groups: [] },
      ]),
    );
    expect(await groupDoc(w.t, crew.groupId)).toBeNull();
    expect(await rowsOf(w.t, crew.groupId)).toEqual([]);
    expect(await claimOf(w.t, crew.name)).toBeNull();
    expect(await claimOf(w.t, readers.name)).not.toBeNull();
    expect(await rowsOf(w.t, readers.groupId)).toHaveLength(1);
    expect(await queue(w.t)).toEqual([]);
  });

  test("a member added after the deletion was queued is put without the group too, and the run goes round again", async () => {
    const w = await world();
    const crew = await makeGroup(w, "crew");
    await joinGroup(w, crew.groupId, w.guest);
    await joinGroup(w, crew.groupId, w.editor);
    const late = await createUser(w.t, "ungroup-late@example.com");
    await createWorkspace(w.t, late, "ungroup-late");
    await addMember(w.t, w.shared, late, "member", w.owner);
    await setHomes(w.t, w.shared, { access: "object" });

    await asUser(w.t, w.owner).mutation(api.functions.groups.deleteGroup, { workspaceId: w.shared, groupId: crew.groupId });
    await w.t.run((ctx) =>
      ctx.db.insert("workspaceGroupMembers", { groupId: crew.groupId, workspaceId: w.shared, userId: late, addedBy: w.owner, addedAt: Date.now() }),
    );
    const [job] = await queue(w.t);

    const fake = fakeObjects();
    expect(await runQueued(w.t, job._id, fake)).toBe("done");
    expect(fake.puts.filter((put) => put.userId === String(late))).toEqual([{ userId: String(late), groups: [] }]);
    expect(fake.puts.some((put) => put.groups.includes(crew.name))).toBe(false);
    expect(await groupDoc(w.t, crew.groupId)).toBeNull();
    expect(await rowsOf(w.t, crew.groupId)).toEqual([]);
    expect(await claimOf(w.t, crew.name)).toBeNull();
    expect(await queue(w.t)).toEqual([]);
  });
});

describe("creating and joining a group at object", () => {
  test("an empty group is created with no outbox entry; joining it is let through and queued as adds", async () => {
    const w = await world();
    await setHomes(w.t, w.shared, { access: "object" });
    const empty = await makeGroup(w, "empty");
    expect(empty.name).toEqual(expect.any(String));
    expect(await outbox(w.t)).toEqual([]);

    await joinGroup(w, empty.groupId, w.guest);
    expect(await outbox(w.t)).toEqual([
      expect.objectContaining({ workspaceId: w.shared, tables: [], adds: { userIds: [w.guest], inviteIds: [] } }),
    ]);
    expect(await rowsOf(w.t, empty.groupId)).toHaveLength(1);
  });
});

describe("a grant's tools-listed stamp at a person on object", () => {
  test("the stamp is not refused and writes nothing to the object; a scope change on the same grant is refused", async () => {
    const w = await world();
    const hashedAccessToken = "e".repeat(64);
    const grantId = await w.t.run((ctx) =>
      ctx.db.insert("oauthGrants", {
        workspaceId: w.guestPersonal,
        userId: w.guest,
        clientId: "claude",
        scopes: ["context.read"],
        hashedRefreshToken: "d".repeat(64),
        hashedAccessToken,
        status: "active",
        createdAt: Date.now(),
      }),
    );
    await setHomes(w.t, w.guestPersonal, { personAccess: "object" });

    await w.t.mutation(internal.functions.grants.noteToolsListed, { hashedAccessToken });
    expect((await w.t.run((ctx) => ctx.db.get(grantId)))?.toolsListedAt).toEqual(expect.any(Number));
    expect(await outbox(w.t)).toEqual([]);

    const refused = await w.t
      .run(async (ctx) => {
        const watch = watchDb(ctx.db);
        await watch.db.patch(grantId, { scopes: ["context.read", "context.write"] });
        await flushAccessWrites({ ...ctx, db: watch.db }, watch.accessWrites, { writeBehind: false });
      })
      .catch((error: unknown) => error);
    expect(errorCode(refused)).toBe(WORKSPACE_SWITCHED);
  });
});

describe("deleting a workspace with an ungroup job queued", () => {
  test("the workspace deletion still queues its own job, beside the ungroup job", async () => {
    const w = await world();
    const crew = await makeGroup(w, "crew");
    await joinGroup(w, crew.groupId, w.guest);
    await setHomes(w.t, w.shared, { access: "object" });
    await leaveGroup(w, crew.groupId, w.guest);

    expect(
      await asUser(w.t, w.owner).mutation(api.functions.account.deleteWorkspace, { workspaceId: w.shared, confirmSlug: "ungroup-shared" }),
    ).toEqual({ deleted: true });
    const jobs = await queue(w.t);
    expect(jobs.map((job) => job.kind).sort()).toEqual(["ungroup", "workspace"]);
    expect(jobs.find((job) => job.kind === "workspace")).toMatchObject({ workspaceId: w.shared });
    expect(jobs.find((job) => job.kind === "ungroup")).toMatchObject({ groupId: crew.groupId, userIds: [w.guest] });
  });
});

describe("a Tex chat guest leaving the chat's group at object", () => {
  test("unsyncChatPeople queues the same ungroup job; the run takes the group away from the guest's row", async () => {
    const w = await world();
    const crew = await makeGroup(w, "crew");
    await setHomes(w.t, w.shared, { access: "object" });
    const chatId = await w.t.run((ctx) =>
      ctx.db.insert("textGroups", {
        groupKey: "example-chat-key",
        workspaceId: w.shared,
        guestGroupId: crew.groupId,
        boundBy: w.owner,
        lastSeenAt: Date.now(),
      }),
    );
    await w.t.run((ctx) =>
      ctx.db.insert("workspaceGroupMembers", {
        groupId: crew.groupId,
        workspaceId: w.shared,
        userId: w.guest,
        addedBy: w.owner,
        addedAt: Date.now(),
        viaChat: chatId,
      }),
    );

    await w.t.run(async (ctx) => {
      const chat = await ctx.db.get(chatId);
      await unsyncChatPeople(ctx, chat!);
    });
    const jobs = await queue(w.t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "ungroup", groupId: crew.groupId, userIds: [w.guest] });
    expect(await rowsOf(w.t, crew.groupId)).toHaveLength(1);

    const fake = fakeObjects();
    expect(await runQueued(w.t, jobs[0]._id, fake)).toBe("done");
    expect(fake.puts).toEqual([{ userId: String(w.guest), groups: [] }]);
    expect(await rowsOf(w.t, crew.groupId)).toEqual([]);
    expect(await queue(w.t)).toEqual([]);
  });
});
