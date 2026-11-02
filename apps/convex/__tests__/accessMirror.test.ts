/**
 * Convex written behind an object's take-away access write (`functions/accessMirror.ts`, `POST /gateway/access/mirror`).
 *
 * Sabotage, each confirmed to fail a case here: build `apply` with the plain `internalMutation` (a switched workspace
 * refuses its own write-behind); drop the personal-workspace check on a connection (one person's object revokes
 * another's grant); drop the owner check (a mirror demotes or removes the owner).
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, createUser, createWorkspace, gatewayPost, setupTest, type TestConvex } from "./fixtures.helpers";

async function world() {
  const t = setupTest();
  const owner = await createUser(t, "mirror-owner@example.com");
  const ownerPersonal = await createWorkspace(t, owner, "mirror-owner");
  const shared = await createWorkspace(t, owner, "mirror-shared", { kind: "shared" });
  const member = await createUser(t, "mirror-member@example.com");
  const memberPersonal = await createWorkspace(t, member, "mirror-member");
  await addMember(t, shared, member, "editor", owner);
  // Every scope switched: the write-behind must still land, and nothing is pushed back.
  await t.run(async (ctx) => {
    for (const workspaceId of [shared, ownerPersonal, memberPersonal]) {
      await ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "bucket", since: 0, access: "object", personAccess: "object" });
    }
  });
  return { t, owner, ownerPersonal, shared, member, memberPersonal };
}

const membership = (t: TestConvex, workspaceId: Id<"workspaces">, userId: Id<"users">) =>
  t.run((ctx) => ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId)).unique());

async function grant(t: TestConvex, workspaceId: Id<"workspaces">, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db.insert("oauthGrants", { workspaceId, userId, clientId: "claude", scopes: ["context.read"], hashedRefreshToken: "a".repeat(64), status: "active", createdAt: 1 }),
  );
}

describe("the write-behind", () => {
  test("changes a role, then removes the member, on a switched workspace; again is a no-op", async () => {
    const { t, owner, shared, member } = await world();
    const set = { workspaceId: shared, change: { op: "set_role" as const, userId: String(member), role: "member" as const, at: 2, by: String(owner) } };
    expect(await t.mutation(internal.functions.accessMirror.apply, set)).toEqual({ applied: true });
    expect((await membership(t, shared, member))?.role).toBe("member");
    expect(await t.mutation(internal.functions.accessMirror.apply, set)).toEqual({ applied: false });

    const remove = { workspaceId: shared, change: { op: "remove_member" as const, userId: String(member), at: 3, by: String(owner) } };
    expect(await t.mutation(internal.functions.accessMirror.apply, remove)).toEqual({ applied: true });
    expect(await membership(t, shared, member)).toBeNull();
    expect(await t.mutation(internal.functions.accessMirror.apply, remove)).toEqual({ applied: false });
    expect(await t.run((ctx) => ctx.db.query("accessObjectOutbox").collect())).toEqual([]);
  });

  test("never removes or demotes the owner", async () => {
    const { t, owner, shared } = await world();
    for (const change of [
      { op: "remove_member" as const, userId: String(owner), at: 2, by: String(owner) },
      { op: "set_role" as const, userId: String(owner), role: "member" as const, at: 2, by: String(owner) },
    ]) {
      expect(await t.mutation(internal.functions.accessMirror.apply, { workspaceId: shared, change })).toEqual({ applied: false, refused: "OWNER" });
    }
    expect((await membership(t, shared, owner))?.role).toBe("owner");
  });

  test("revokes a connection only for the person whose object asks", async () => {
    const { t, owner, ownerPersonal, member, memberPersonal } = await world();
    const grantId = await grant(t, memberPersonal, member);
    const change = { op: "revoke_connection" as const, grantId: String(grantId), at: 2, by: String(owner) };
    expect(await t.mutation(internal.functions.accessMirror.apply, { workspaceId: ownerPersonal, change })).toEqual({ applied: false, refused: "WRONG_WORKSPACE" });
    expect((await t.run((ctx) => ctx.db.get(grantId)))?.status).toBe("active");
    expect(await t.mutation(internal.functions.accessMirror.apply, { workspaceId: memberPersonal, change: { ...change, by: String(member) } })).toEqual({ applied: true });
    expect((await t.run((ctx) => ctx.db.get(grantId)))?.status).toBe("revoked");
  });

  test("withdraws an invitation only in its own workspace", async () => {
    const t = setupTest();
    const owner = await createUser(t, "mirror-inviter@example.com");
    await createWorkspace(t, owner, "mirror-inviter");
    const shared = await createWorkspace(t, owner, "mirror-invites", { kind: "shared" });
    const other = await createWorkspace(t, owner, "mirror-elsewhere", { kind: "shared" });
    const invite = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaceInvitations", {
        workspaceId: shared,
        inviteeKind: "email",
        invitee: "someone@example.com",
        role: "member",
        invitedBy: owner,
        token: "t".repeat(43),
        status: "pending",
        expiresAt: Date.now() + 86_400_000,
        createdAt: Date.now(),
      });
      return id;
    });
    const change = { op: "revoke_invite" as const, invitationId: String(invite), at: 2, by: String(owner) };
    expect(await t.mutation(internal.functions.accessMirror.apply, { workspaceId: other, change })).toEqual({ applied: false, refused: "WRONG_WORKSPACE" });
    expect(await t.mutation(internal.functions.accessMirror.apply, { workspaceId: shared, change })).toEqual({ applied: true });
    expect((await t.run((ctx) => ctx.db.get(invite)))?.status).toBe("revoked");
  });
});

describe("the route", () => {
  test("is behind the gateway secret, answers 409 for a refusal and 400 for a body that is not a change", async () => {
    const { t, owner, shared, member } = await world();
    const body = { workspaceId: shared, change: { op: "set_role", userId: member, role: "member", at: 2, by: owner } };
    expect((await gatewayPost(t, "/gateway/access/mirror", body, { secret: "wrong" })).status).toBe(401);
    expect((await membership(t, shared, member))?.role).toBe("editor");

    const ok = await gatewayPost(t, "/gateway/access/mirror", body);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ applied: true });

    const refused = await gatewayPost(t, "/gateway/access/mirror", { workspaceId: shared, change: { op: "remove_member", userId: owner, at: 3, by: owner } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ applied: false, refused: "OWNER" });

    expect((await gatewayPost(t, "/gateway/access/mirror", { workspaceId: shared, change: { op: "drop_table" } })).status).toBe(400);
    expect((await gatewayPost(t, "/gateway/access/mirror", { workspaceId: shared, change: { op: "set_role", userId: member, role: "owner", at: 4, by: owner } })).status).toBe(400);
  });
});
