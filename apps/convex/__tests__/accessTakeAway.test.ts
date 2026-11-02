/**
 * Queued deletions that take access away in the objects first (`functions/accessTakeAway.ts`,
 * `functions/lib/accessHandOff/takeAway.ts`).
 *
 * Covers: no switched scope deletes as before; a person on `object` queues the account deletion and deletes nothing
 * until the queue runs; the queue revokes the person's active grants in their object (never the texting client) and
 * only then deletes Convex's rows; a refusing object leaves everything queued and retryable; a shared workspace on
 * `object` has all its members and pending invitations removed in its object, and grants made there are revoked in
 * its members' personal objects only where those are `dual` or `object`; a non-owner's account deletion removes only
 * that one member; a deletion touching only `dual` scopes is never queued.
 *
 * Sabotage, each confirmed to fail a case here: finish the Convex deletion when an object refused; never queue; send
 * a texting client's grant to an object; refuse (rather than write behind) a switched scope's own rows in `finish`.
 *
 * Every value is fake (example.com). The object is a fake recording every call as {workspaceId, op, keys}.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { runTakeAway, type OpenObject } from "../functions/accessTakeAway";
import { takeAwaySteps } from "../functions/lib/accessHandOff/takeAway";
import { addMember, asUser, createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";

const DAY = 86_400_000;

type Call = { workspaceId: string; op: string; keys: string[] };
type Mode = "working" | "refuse";

/** The object's side of a take-away: records every call, and answers `{ error }` for all of them in `refuse` mode. */
function fakeObjects() {
  const calls: Call[] = [];
  let mode: Mode = "working";
  const answer = (workspaceId: Id<"workspaces">, op: string, keys: string[], ok: unknown) => {
    calls.push({ workspaceId: String(workspaceId), op, keys });
    return mode === "refuse" ? { error: "refused" } : ok;
  };
  const open: OpenObject = (workspaceId) => ({
    members: {
      remove: async (userIds) => answer(workspaceId, "members.remove", userIds, { removed: userIds.length }),
      put: async (rows: unknown[]) => answer(workspaceId, "members.put", rows.map((row: unknown) => String((row as { userId: string }).userId)), { kept: rows.length }),
    },
    invites: { remove: async (ids) => answer(workspaceId, "invites.remove", ids, { removed: ids.length }) },
    access: {
      connections: { revoke: async (grantId) => answer(workspaceId, "connections.revoke", [grantId], { revoked: true }) },
    },
  });
  return { calls, open, setMode: (next: Mode) => (mode = next) };
}

async function world() {
  const t = setupTest();
  const alice = await createUser(t, "take-alice@example.com");
  const alicePersonal = await createWorkspace(t, alice, "take-alice");
  return { t, alice, alicePersonal };
}

async function setHomes(t: TestConvex, workspaceId: Id<"workspaces">, homes: { access?: "dual" | "object"; personAccess?: "dual" | "object" }) {
  await t.run((ctx) => ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "bucket", since: 0, ...homes }));
}

async function grant(t: TestConvex, workspaceId: Id<"workspaces">, userId: Id<"users">, clientId = "claude"): Promise<Id<"oauthGrants">> {
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

const queue = (t: TestConvex) => t.run((ctx) => ctx.db.query("accessTakeAways").collect());
const membershipsOf = (t: TestConvex, userId: Id<"users">) =>
  t.run((ctx) => ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
const grantsOf = (t: TestConvex, userId: Id<"users">) =>
  t.run((ctx) => ctx.db.query("oauthGrants").withIndex("by_user", (q) => q.eq("userId", userId)).collect());

async function runQueued(t: TestConvex, id: Id<"accessTakeAways">, fake: ReturnType<typeof fakeObjects>) {
  return await t.action(async (ctx) => await runTakeAway(ctx, id, fake.open));
}

describe("deletion with no switched scope", () => {
  test("deletes as before and queues nothing", async () => {
    const { t, alice } = await world();
    await grant(t, (await membershipsOf(t, alice))[0].workspaceId, alice);
    expect(await asUser(t, alice).mutation(api.functions.account.deleteAccount, {})).toEqual({ deleted: true });
    expect(await membershipsOf(t, alice)).toEqual([]);
    expect(await queue(t)).toEqual([]);
  });
});

describe("a person on object", () => {
  test("deleteAccount queues the deletion and deletes nothing; a second ask queues no second row", async () => {
    const { t, alice, alicePersonal } = await world();
    await grant(t, alicePersonal, alice);
    await setHomes(t, alicePersonal, { personAccess: "object" });

    expect(await asUser(t, alice).mutation(api.functions.account.deleteAccount, {})).toEqual({ deleted: true });
    const rows = await queue(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "account", userId: alice, attempt: 0 });
    expect(await membershipsOf(t, alice)).toHaveLength(1);
    expect(await grantsOf(t, alice)).toHaveLength(1);

    await asUser(t, alice).mutation(api.functions.account.deleteAccount, {});
    expect(await queue(t)).toHaveLength(1);
  });

  test("the queued run revokes each active non-texting grant in the personal object, then deletes Convex's rows", async () => {
    const { t, alice, alicePersonal } = await world();
    const first = await grant(t, alicePersonal, alice);
    const second = await grant(t, alicePersonal, alice, "claude_desktop");
    await setHomes(t, alicePersonal, { personAccess: "object" });
    await asUser(t, alice).mutation(api.functions.account.deleteAccount, {});
    const [row] = await queue(t);

    const fake = fakeObjects();
    expect(await runQueued(t, row._id, fake)).toBe("done");

    expect(fake.calls.every((call) => call.workspaceId === String(alicePersonal) && call.op === "connections.revoke")).toBe(true);
    expect(fake.calls.flatMap((call) => call.keys).sort()).toEqual([String(first), String(second)].sort());
    expect(await membershipsOf(t, alice)).toEqual([]);
    expect(await grantsOf(t, alice)).toEqual([]);
    expect(await queue(t)).toEqual([]);
  });

  test("a refusing object leaves Convex and the queue untouched; once it answers, the same deletion completes", async () => {
    const { t, alice, alicePersonal } = await world();
    await grant(t, alicePersonal, alice);
    await setHomes(t, alicePersonal, { personAccess: "object" });
    await asUser(t, alice).mutation(api.functions.account.deleteAccount, {});
    const [row] = await queue(t);

    const fake = fakeObjects();
    fake.setMode("refuse");
    expect(await runQueued(t, row._id, fake)).toBe("failed");
    expect(await membershipsOf(t, alice)).toHaveLength(1);
    expect(await grantsOf(t, alice)).toHaveLength(1);
    expect(await queue(t)).toEqual([row]);

    fake.setMode("working");
    expect(await runQueued(t, row._id, fake)).toBe("done");
    expect(await membershipsOf(t, alice)).toEqual([]);
    expect(await queue(t)).toEqual([]);
  });

  test("a texting client's grant is never sent to the object's revoke", async () => {
    const { t, alice, alicePersonal } = await world();
    const claude = await grant(t, alicePersonal, alice);
    const texting = await grant(t, alicePersonal, alice, "context_texts");
    await setHomes(t, alicePersonal, { personAccess: "object" });
    await asUser(t, alice).mutation(api.functions.account.deleteAccount, {});
    const [row] = await queue(t);

    const fake = fakeObjects();
    expect(await runQueued(t, row._id, fake)).toBe("done");
    const revoked = fake.calls.flatMap((call) => call.keys);
    expect(revoked).toEqual([String(claude)]);
    expect(revoked).not.toContain(String(texting));
  });
});

describe("a shared workspace on object", () => {
  test("deleteWorkspace queues; the run removes every member and pending invitation in its object, and revokes grants made there in dual personal objects", async () => {
    const { t, alice: owner, alicePersonal: ownerPersonal } = await world();
    const shared = await createWorkspace(t, owner, "take-shared", { kind: "shared" });
    const guest = await createUser(t, "take-guest@example.com");
    const guestPersonal = await createWorkspace(t, guest, "take-guest");
    await addMember(t, shared, guest, "member", owner);
    const invitation = await t.run((ctx) =>
      ctx.db.insert("workspaceInvitations", {
        workspaceId: shared,
        inviteeKind: "name",
        invitee: "take-pending",
        role: "member",
        invitedBy: owner,
        token: "t".repeat(43),
        status: "pending",
        expiresAt: Date.now() + DAY,
        createdAt: Date.now(),
      }),
    );
    const guestGrant = await grant(t, shared, guest);
    await grant(t, ownerPersonal, owner);
    await setHomes(t, shared, { access: "object" });
    await setHomes(t, guestPersonal, { personAccess: "dual" });

    expect(await asUser(t, owner).mutation(api.functions.account.deleteWorkspace, { workspaceId: shared, confirmSlug: "take-shared" })).toEqual({ deleted: true });
    const [row] = await queue(t);
    expect(row).toMatchObject({ kind: "workspace", workspaceId: shared });

    const fake = fakeObjects();
    expect(await runQueued(t, row._id, fake)).toBe("done");

    const sharedCalls = fake.calls.filter((call) => call.workspaceId === String(shared));
    expect(sharedCalls.filter((call) => call.op === "members.remove").flatMap((call) => call.keys).sort()).toEqual([String(owner), String(guest)].sort());
    expect(sharedCalls.filter((call) => call.op === "invites.remove").flatMap((call) => call.keys)).toEqual([String(invitation)]);
    expect(fake.calls.filter((call) => call.op === "connections.revoke")).toEqual([{ workspaceId: String(guestPersonal), op: "connections.revoke", keys: [String(guestGrant)] }]);
    expect(fake.calls.some((call) => call.workspaceId === String(ownerPersonal))).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(shared))).toBeNull();
  });
});

describe("a non-owner leaving a shared workspace on object", () => {
  test("the account's step for that workspace removes only that one userId", async () => {
    const { t, alice: owner } = await world();
    const shared = await createWorkspace(t, owner, "take-team", { kind: "shared" });
    const guest = await createUser(t, "take-member@example.com");
    await createWorkspace(t, guest, "take-member");
    await addMember(t, shared, guest, "member", owner);
    await setHomes(t, shared, { access: "object" });

    expect(await asUser(t, guest).mutation(api.functions.account.deleteAccount, {})).toEqual({ deleted: true });
    const [row] = await queue(t);
    const fake = fakeObjects();
    expect(await runQueued(t, row._id, fake)).toBe("done");

    expect(fake.calls).toEqual([{ workspaceId: String(shared), op: "members.remove", keys: [String(guest)] }]);
    expect((await membershipsOf(t, owner)).map((membership) => String(membership.workspaceId))).toContain(String(shared));
  });
});

describe("dual scopes", () => {
  test("a dual personal scope gets its object step but does not queue the deletion", async () => {
    const { t, alice, alicePersonal } = await world();
    const dualGrant = await grant(t, alicePersonal, alice);
    await setHomes(t, alicePersonal, { personAccess: "dual" });

    const steps = await t.run((ctx) => takeAwaySteps(ctx, { kind: "account", userId: alice }));
    expect(steps).toEqual([{ scope: "person", workspaceId: alicePersonal, home: "dual", grantIds: [String(dualGrant)] }]);

    expect(await asUser(t, alice).mutation(api.functions.account.deleteAccount, {})).toEqual({ deleted: true });
    expect(await queue(t)).toEqual([]);
    expect(await membershipsOf(t, alice)).toEqual([]);
    expect(await grantsOf(t, alice)).toEqual([]);
  });
});
