/**
 * One owner, plus co-owners (decided by the owner, 2026-11-25;
 * `docs/decisions/identity-and-access/co-owners.md`, `functions/lib/workspaces/coOwners.ts`).
 *
 * Covers: only a shared workspace's owner makes a co-owner, after their email code; a co-owner runs the workspace
 * like the owner (removes and re-roles members) but takes none of the one-way steps (delete, hand over, make or remove
 * co-owners, disconnect storage, the billing portal); nobody changes or removes the owner; a co-owner steps down and
 * leaves on their own; the owner hands over to a co-owner and stays on as one; the owner's account going leaves the
 * workspace to the longest-serving co-owner; on a workspace whose object decides its members, an owner-role change is
 * queued object-first and lands in Convex only behind it.
 *
 * Sabotage, each confirmed to fail a case here: `requirePrimaryOwner` checking only the owner role; dropping the
 * email-code check from making a co-owner; writing the role straight to Convex on an `object` workspace; leaving
 * `handToSuccessor` out of account deletion.
 *
 * Every value is fake (example.invalid).
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { runTakeAway, type OpenObject } from "../functions/accessTakeAway";
import {
  asPhoneOnly,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  joinViaInvitation,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

async function team() {
  const t = setupTest();
  const owner = await createUser(t, "co-owner-owner@example.invalid");
  const sayo = await createUser(t, "co-owner-sayo@example.invalid");
  const john = await createUser(t, "co-owner-john@example.invalid");
  const lk = await createUser(t, "co-owner-lk@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "co-owner-team", { kind: "shared", displayName: "Co-owner Team" });
  for (const [invitee, addressedTo, role] of [
    [sayo, "co-owner-sayo@example.invalid", "editor"],
    [john, "co-owner-john@example.invalid", "editor"],
    [lk, "co-owner-lk@example.invalid", "member"],
  ] as const) {
    await joinViaInvitation(t, { workspaceId, owner, invitee, addressedTo, role });
  }
  return { t, owner, sayo, john, lk, workspaceId };
}

const makeCoOwner = (t: TestConvex, actor: Id<"users">, workspaceId: Id<"workspaces">, userId: Id<"users">) =>
  asUser(t, actor).mutation(api.functions.workspaces.setMemberRole, { workspaceId, userId, role: "owner" });

const roles = async (t: TestConvex, viewer: Id<"users">, workspaceId: Id<"workspaces">) =>
  Object.fromEntries(
    (await asUser(t, viewer).query(api.functions.workspaces.listMembers, { workspaceId })).map((m) => [
      m.userId,
      m.isOwner ? "OWNER" : m.role,
    ]),
  );

const codeOf = async (run: () => Promise<unknown>) => errorCode(await captureError(run));

describe("making a co-owner", () => {
  test("the owner makes one; the list tells the owner from co-owners; the audit names it", async () => {
    const { t, owner, sayo, workspaceId } = await team();
    expect(await makeCoOwner(t, owner, workspaceId, sayo)).toEqual({ role: "owner" });
    const members = await asUser(t, sayo).query(api.functions.workspaces.listMembers, { workspaceId });
    expect(members.filter((m) => m.role === "owner").map((m) => [m.userId, m.isOwner])).toEqual([
      [owner, true],
      [sayo, false],
    ]);
    const events = await asUser(t, owner).query(api.functions.audit.listEvents, { workspaceId });
    expect(events.find((e) => e.action === "member.role_changed")?.details).toMatchObject({ targetUserId: sayo, role: "owner" });
  });

  test("a co-owner, an editor or a member cannot make one", async () => {
    const { t, owner, sayo, john, lk, workspaceId } = await team();
    await makeCoOwner(t, owner, workspaceId, sayo);
    expect(await codeOf(() => makeCoOwner(t, sayo, workspaceId, john))).toBe("OWNER_ONLY");
    expect(await codeOf(() => makeCoOwner(t, john, workspaceId, john))).toBe("INSUFFICIENT_ROLE");
    expect(await codeOf(() => makeCoOwner(t, lk, workspaceId, lk))).toBe("INSUFFICIENT_ROLE");
    expect(await roles(t, owner, workspaceId)).toMatchObject({ [john]: "editor", [lk]: "member" });
  });

  test("a phone alone cannot make one: it needs the owner's email code", async () => {
    const { t, owner, sayo, workspaceId } = await team();
    const { view } = await asPhoneOnly(t, owner);
    expect(
      await codeOf(() => view.mutation(api.functions.workspaces.setMemberRole, { workspaceId, userId: sayo, role: "owner" })),
    ).toBe("EMAIL_PROOF_REQUIRED");
    expect(await roles(t, owner, workspaceId)).toMatchObject({ [sayo]: "editor" });
  });

  test("a personal workspace keeps one owner", async () => {
    const t = setupTest();
    const alice = await createUser(t, "co-owner-alice@example.invalid");
    const bob = await createUser(t, "co-owner-bob@example.invalid");
    const personal = await createWorkspace(t, alice, "co-owner-alice");
    await joinViaInvitation(t, { workspaceId: personal, owner: alice, invitee: bob, addressedTo: "co-owner-bob@example.invalid", role: "editor" });
    expect(await codeOf(() => makeCoOwner(t, alice, personal, bob))).toBe("PERSONAL_CONTEXT");
  });
});

describe("what a co-owner can and cannot do", () => {
  test("runs the people like the owner: changes roles and removes editors and members", async () => {
    const { t, owner, sayo, john, lk, workspaceId } = await team();
    await makeCoOwner(t, owner, workspaceId, sayo);
    await asUser(t, sayo).mutation(api.functions.workspaces.setMemberRole, { workspaceId, userId: john, role: "member" });
    expect(await asUser(t, sayo).mutation(api.functions.workspaces.removeMember, { workspaceId, userId: lk })).toEqual({ removed: true });
    expect(await roles(t, owner, workspaceId)).toEqual({ [owner]: "OWNER", [sayo]: "owner", [john]: "member" });
  });

  test("never touches the owner, nor another co-owner", async () => {
    const { t, owner, sayo, john, workspaceId } = await team();
    await makeCoOwner(t, owner, workspaceId, sayo);
    await makeCoOwner(t, owner, workspaceId, john);
    const set = (actor: Id<"users">, userId: Id<"users">) =>
      asUser(t, actor).mutation(api.functions.workspaces.setMemberRole, { workspaceId, userId, role: "editor" });
    expect(await codeOf(() => set(sayo, owner))).toBe("CANNOT_CHANGE_OWNER_ROLE");
    expect(await codeOf(() => set(sayo, john))).toBe("OWNER_ONLY");
    expect(await codeOf(() => asUser(t, sayo).mutation(api.functions.workspaces.removeMember, { workspaceId, userId: owner }))).toBe(
      "CANNOT_REMOVE_OWNER",
    );
    expect(await codeOf(() => asUser(t, sayo).mutation(api.functions.workspaces.removeMember, { workspaceId, userId: john }))).toBe("CO_OWNER");
    expect(await roles(t, owner, workspaceId)).toMatchObject({ [owner]: "OWNER", [sayo]: "owner", [john]: "owner" });
  });

  test("takes none of the one-way steps", async () => {
    const { t, owner, sayo, workspaceId } = await team();
    await makeCoOwner(t, owner, workspaceId, sayo);
    const as = asUser(t, sayo);
    expect(await codeOf(() => as.mutation(api.functions.account.deleteWorkspace, { workspaceId, confirmSlug: "co-owner-team" }))).toBe("OWNER_ONLY");
    expect(await codeOf(() => as.mutation(api.functions.workspaces.handOver, { workspaceId, userId: sayo }))).toBe("OWNER_ONLY");
    expect(await codeOf(() => as.mutation(api.functions.storage.disconnectStorage, { workspaceId }))).toBe("OWNER_ONLY");
    expect(await codeOf(() => as.mutation(api.functions.billing.startPortal, { workspaceId }))).toBe("OWNER_ONLY");
  });
});

describe("stepping down and leaving", () => {
  test("a co-owner steps down and leaves on their own; the owner removes a co-owner by stepping them down first", async () => {
    const { t, owner, sayo, john, workspaceId } = await team();
    await makeCoOwner(t, owner, workspaceId, sayo);
    await makeCoOwner(t, owner, workspaceId, john);
    expect(await asUser(t, sayo).mutation(api.functions.workspaces.setMemberRole, { workspaceId, userId: sayo, role: "editor" })).toEqual({
      role: "editor",
    });
    expect(await asUser(t, john).mutation(api.functions.workspaces.leaveWorkspace, { workspaceId })).toEqual({ left: true });
    await makeCoOwner(t, owner, workspaceId, sayo);
    await asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, { workspaceId, userId: sayo, role: "member" });
    expect(await asUser(t, owner).mutation(api.functions.workspaces.removeMember, { workspaceId, userId: sayo })).toEqual({ removed: true });
  });

  test("the owner cannot leave or step down while they own it", async () => {
    const { t, owner, sayo, workspaceId } = await team();
    await makeCoOwner(t, owner, workspaceId, sayo);
    expect(await codeOf(() => asUser(t, owner).mutation(api.functions.workspaces.leaveWorkspace, { workspaceId }))).toBe("OWNER_CANNOT_LEAVE");
    expect(
      await codeOf(() => asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, { workspaceId, userId: owner, role: "editor" })),
    ).toBe("CANNOT_CHANGE_OWNER_ROLE");
  });
});

describe("handing the workspace over", () => {
  test("only to a co-owner; the old owner stays a co-owner and loses the one-way steps", async () => {
    const { t, owner, sayo, john, workspaceId } = await team();
    expect(await codeOf(() => asUser(t, owner).mutation(api.functions.workspaces.handOver, { workspaceId, userId: john }))).toBe("NOT_A_CO_OWNER");
    await makeCoOwner(t, owner, workspaceId, sayo);
    expect(await asUser(t, owner).mutation(api.functions.workspaces.handOver, { workspaceId, userId: sayo })).toEqual({ ownerUserId: sayo });
    expect(await roles(t, owner, workspaceId)).toMatchObject({ [owner]: "owner", [sayo]: "OWNER" });
    expect(await codeOf(() => makeCoOwner(t, owner, workspaceId, john))).toBe("OWNER_ONLY");
    expect(await makeCoOwner(t, sayo, workspaceId, john)).toEqual({ role: "owner" });
    // Handed over, the old owner may now leave.
    expect(await asUser(t, owner).mutation(api.functions.workspaces.leaveWorkspace, { workspaceId })).toEqual({ left: true });
    const events = await asUser(t, sayo).query(api.functions.audit.listEvents, { workspaceId });
    expect(events.find((e) => e.action === "workspace.owner_changed")?.details).toMatchObject({ previousOwnerUserId: owner, ownerUserId: sayo });
  });

  test("a phone alone cannot hand it over", async () => {
    const { t, owner, sayo, workspaceId } = await team();
    await makeCoOwner(t, owner, workspaceId, sayo);
    const { view } = await asPhoneOnly(t, owner);
    expect(await codeOf(() => view.mutation(api.functions.workspaces.handOver, { workspaceId, userId: sayo }))).toBe("EMAIL_PROOF_REQUIRED");
  });

  test("the owner's account going leaves the workspace to the longest-serving co-owner", async () => {
    const { t, owner, sayo, john, workspaceId } = await team();
    await makeCoOwner(t, owner, workspaceId, sayo);
    await makeCoOwner(t, owner, workspaceId, john);
    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    expect(await roles(t, sayo, workspaceId)).toMatchObject({ [sayo]: "OWNER", [john]: "owner" });
    const workspace = await t.run((ctx) => ctx.db.get(workspaceId));
    expect(workspace?.ownerUserId).toBe(sayo);
  });
});

describe("where the object decides the members", () => {
  function fakeObject() {
    const puts: { userId: string; role: string }[] = [];
    const open: OpenObject = () => ({
      members: {
        remove: async (userIds) => ({ removed: userIds.length }),
        put: async (rows: unknown[]) => {
          for (const row of rows as { userId: string; role: string }[]) puts.push({ userId: row.userId, role: row.role });
          return { kept: rows.length };
        },
      },
      invites: { remove: async (ids) => ({ removed: ids.length }) },
      access: { connections: { revoke: async () => ({ revoked: true }) } },
    });
    return { puts, open };
  }

  test("making a co-owner is queued, put in the object, and only then written to Convex", async () => {
    const { t, owner, sayo, workspaceId } = await team();
    // The object keys a member by their personal workspace, as every member row it holds.
    await createWorkspace(t, sayo, "co-owner-sayo");
    await t.run((ctx) => ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "bucket", since: 0, access: "object" }));
    expect(await makeCoOwner(t, owner, workspaceId, sayo)).toEqual({ role: "owner", pending: true });
    const [job] = await t.run((ctx) => ctx.db.query("accessTakeAways").collect());
    expect(job).toMatchObject({ kind: "role", userId: sayo, role: "owner", actorId: owner });
    const before = await t.run((ctx) =>
      ctx.db.query("workspaceMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
    );
    expect(before.find((m) => m.userId === sayo)?.role).toBe("editor");

    const fake = fakeObject();
    expect(await t.action((ctx) => runTakeAway(ctx, job._id, fake.open))).toBe("done");
    expect(fake.puts).toEqual([{ userId: String(sayo), role: "owner" }]);
    expect(await roles(t, owner, workspaceId)).toMatchObject({ [sayo]: "owner" });
    expect(await t.run((ctx) => ctx.db.query("accessTakeAways").collect())).toEqual([]);
  });
});
