/**
 * A token's workspace list is saved after the first resolve and reused while
 * the grant, memberships, groups, handles, emails, and access versions are
 * unchanged (`lib/controlPlane/grantCache.ts`). The access snapshot is not
 * read on a hit, which is what made `resolveGrantByAccessToken` and
 * `readClearance` the heavy half of the auth chain.
 *
 * A revoked grant is refused before the saved list is read. A snapshot edited
 * without moving the version is not seen: the version is what says the
 * snapshot changed. Moving the version (or removing the membership) builds
 * the list again.
 *
 * The saved row leaves with the token: revoke, rotation, expiry, account
 * deletion and workspace deletion (`grantCacheRows.ts`). A hit still requires
 * the grant to be live first.
 *
 * Sabotage: skip the cache read in `loadGrantWorkspaces` and the tampered
 * snapshot shows up on the second session. Skip `forgetGrantResolveCache` in
 * `revokeGrant` and the revoked token's row stays. Skip it in `rotateGrant`
 * and the rotated token's row stays. Skip `pruneExpiredGrantCache` in
 * `rememberGrantResolveHandler` and the expired row survives the next save.
 * Skip the `userId` forget in `deletePersonalRows` and account deletion leaves
 * the row. Skip the `workspaceId` forget in `deleteWorkspaceCascade` and
 * workspace deletion leaves the list that named it. Skip the undated drain in
 * `pruneGrantResolveCache` and the row saved before `expiresAt` existed stays.
 * Stop deleting `nodeAccessVersions` in `forgetWorkspaceTree` and the rebuilt
 * version stays at 7 (`nodesPurge.test.ts`).
 */

import { expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import { hashToken } from "../../functions/lib/crypto";
import {
  ACCESS_A,
  ACCESS_A_SIBLING,
  ACCESS_B,
  CLIENT_A,
  REFRESH_A,
  bodyOf,
  removeMembership,
  twoConnectedTenants,
} from "./fixtures.helpers";
import { asUser, createWorkspace, gatewayPost } from "../fixtures.helpers";

test("a second resolve reuses the saved list and ignores a snapshot that did not change version", async () => {
  const { t, alice, aliceWs } = await twoConnectedTenants();
  const first = await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }));
  const saved = await t.run(async (ctx) => ctx.db.query("grantResolveCache").unique());
  expect(saved).not.toBeNull();

  await t.run(async (ctx) => {
    const extra = {
      path: "tampered.md",
      noteId: "tamperednoteid",
      kind: "file" as const,
      grantees: [{ kind: "user" as const, id: alice, role: "view" as const }],
    };
    const state = await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
      .unique();
    if (state === null) {
      await ctx.db.insert("nodeAccessState", { workspaceId: aliceWs, version: 0, orphans: [], snapshot: [extra] });
    } else {
      await ctx.db.patch(state._id, { snapshot: [...(state.snapshot ?? []), extra] });
    }
  });

  const second = await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }));
  expect(second.session).toEqual(first.session);
  expect(JSON.stringify(second.session)).not.toContain("tamperednoteid");
});

test("a revoked grant is not served from the saved list", async () => {
  const { t, grantA } = await twoConnectedTenants();
  expect((await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }))).session).not.toBeNull();
  await t.run(async (ctx) => {
    await ctx.db.patch(grantA, { status: "revoked" });
  });
  expect((await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }))).session).toBeNull();
});

test("removing the membership builds the list again", async () => {
  const { t, alice, aliceWs } = await twoConnectedTenants();
  expect((await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }))).session).not.toBeNull();
  await removeMembership(t, aliceWs, alice);
  expect((await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }))).session).toBeNull();
});

test("the small access version follows a snapshot refresh", async () => {
  const { t, aliceWs } = await twoConnectedTenants();
  await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A });
  const before = await t.run(async (ctx) =>
    ctx.db.query("nodeAccessVersions").withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs)).unique(),
  );
  expect(before).not.toBeNull();
  const { refreshSnapshot } = await import("../../functions/lib/nodes/accessBackfill");
  await t.run(async (ctx) => {
    await refreshSnapshot(ctx, aliceWs);
  });
  const after = await t.run(async (ctx) =>
    ctx.db.query("nodeAccessVersions").withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs)).unique(),
  );
  expect(after?.version).toBe((before?.version ?? 0) + 1);
  // The saved list was for the old version, so the next resolve still answers.
  const again = await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }));
  expect(again.session).not.toBeNull();
});

test("revoking the grant removes its saved list and leaves a sibling token's list", async () => {
  const { t, alice, grantA } = await twoConnectedTenants();
  await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A });
  await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A_SIBLING });
  await asUser(t, alice).mutation(api.functions.grants.revokeGrant, { grantId: grantA });

  expect((await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }))).session).toBeNull();
  const rows = await t.run(async (ctx) => ctx.db.query("grantResolveCache").collect());
  const revokedHash = await hashToken(ACCESS_A);
  expect(rows.some((row) => row.hashedAccessToken === revokedHash)).toBe(false);
  expect(rows.some((row) => row.grantId === grantA)).toBe(false);
  const sibling = await hashToken(ACCESS_A_SIBLING);
  expect(rows.some((row) => row.hashedAccessToken === sibling)).toBe(true);
  expect((await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A_SIBLING }))).session).not.toBeNull();
});

test("rotating the access token removes the list saved for the old token", async () => {
  const { t } = await twoConnectedTenants();
  await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A });
  const oldHash = await hashToken(ACCESS_A);
  const nextAccess = "cat_rotated_access_token_000000000000";
  const nextRefresh = "crt_rotated_refresh_token_00000000000";
  const rotated = await t.mutation(internal.functions.controlPlane.rotateGrant, {
    hashedRefreshToken: await hashToken(REFRESH_A),
    clientId: CLIENT_A,
    newHashedRefreshToken: await hashToken(nextRefresh),
    newHashedAccessToken: await hashToken(nextAccess),
    accessTokenExpiresAt: Date.now() + 3_600_000,
    scopes: null,
  });
  expect(rotated).not.toBeNull();

  const rows = await t.run(async (ctx) => ctx.db.query("grantResolveCache").collect());
  expect(rows.some((row) => row.hashedAccessToken === oldHash)).toBe(false);
  expect((await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }))).session).toBeNull();
  const again = await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: nextAccess }));
  expect(again.session).not.toBeNull();
  const nextHash = await hashToken(nextAccess);
  const saved = await t.run(async (ctx) =>
    ctx.db.query("grantResolveCache").withIndex("by_token", (q) => q.eq("hashedAccessToken", nextHash)).unique(),
  );
  expect(saved).not.toBeNull();
  expect(saved?.expiresAt).toBeTypeOf("number");
});

test("saving a list drops one whose token has already expired and keeps one that has not", async () => {
  const { t } = await twoConnectedTenants();
  const stale = "ab".repeat(32);
  const kept = "cd".repeat(32);
  await t.run(async (ctx) => {
    await ctx.db.insert("grantResolveCache", {
      hashedAccessToken: stale,
      fingerprint: "stale",
      workspaces: [],
      expiresAt: Date.now() - 1_000,
    });
    await ctx.db.insert("grantResolveCache", {
      hashedAccessToken: kept,
      fingerprint: "kept",
      workspaces: [],
      expiresAt: Date.now() + 3_600_000,
    });
  });
  await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A });
  const rows = await t.run(async (ctx) => ctx.db.query("grantResolveCache").collect());
  expect(rows.some((row) => row.hashedAccessToken === stale)).toBe(false);
  expect(rows.some((row) => row.hashedAccessToken === kept)).toBe(true);
});

test("the prune removes an expired row and a row saved before expiry was stored", async () => {
  const { t } = await twoConnectedTenants();
  const stale = "ab".repeat(32);
  const undated = "ef".repeat(32);
  const kept = "cd".repeat(32);
  await t.run(async (ctx) => {
    await ctx.db.insert("grantResolveCache", {
      hashedAccessToken: stale,
      fingerprint: "stale",
      workspaces: [],
      expiresAt: Date.now() - 1_000,
    });
    await ctx.db.insert("grantResolveCache", {
      hashedAccessToken: undated,
      fingerprint: "undated",
      workspaces: [],
    });
    await ctx.db.insert("grantResolveCache", {
      hashedAccessToken: kept,
      fingerprint: "kept",
      workspaces: [],
      expiresAt: Date.now() + 3_600_000,
    });
  });
  await t.mutation(internal.functions.controlPlane.pruneGrantResolveCache, {});
  const rows = await t.run(async (ctx) => ctx.db.query("grantResolveCache").collect());
  expect(rows.map((row) => row.hashedAccessToken)).toEqual([kept]);
});

test("account deletion leaves no saved list for that person and keeps the other tenant's", async () => {
  const { t, alice, bob, aliceWs } = await twoConnectedTenants();
  await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A });
  await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_B });
  // No workspace link: the cascade's workspace sweep cannot see it. Only the user sweep can.
  const orphan = "11".repeat(32);
  await t.run(async (ctx) => {
    await ctx.db.insert("grantResolveCache", {
      hashedAccessToken: orphan,
      fingerprint: "orphan",
      workspaces: [],
      userId: alice,
      expiresAt: Date.now() + 3_600_000,
    });
  });
  await asUser(t, alice).mutation(api.functions.account.deleteAccount, {});
  const rows = await t.run(async (ctx) => ctx.db.query("grantResolveCache").collect());
  expect(rows.some((row) => row.hashedAccessToken === orphan)).toBe(false);
  const links = await t.run(async (ctx) => ctx.db.query("grantResolveCacheWorkspaces").collect());
  expect(rows.some((row) => row.userId === alice)).toBe(false);
  expect(links.some((link) => link.workspaceId === aliceWs)).toBe(false);
  expect(rows.some((row) => row.userId === bob)).toBe(true);
  expect(await t.run(async (ctx) => ctx.db.get(bob))).not.toBeNull();
});

test("deleting a workspace removes saved lists that name it and leaves the other tenant's", async () => {
  const { t, alice, bob } = await twoConnectedTenants();
  await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A });
  await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_B });
  const crew = await createWorkspace(t, alice, "crew", { kind: "shared" });
  await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A });
  const before = await t.run(async (ctx) => ctx.db.query("grantResolveCache").collect());
  expect(before.some((row) => row.workspaces.some((workspace) => workspace.workspaceId === crew))).toBe(true);

  await asUser(t, alice).mutation(api.functions.account.deleteWorkspace, { workspaceId: crew, confirmSlug: "crew" });

  const rows = await t.run(async (ctx) => ctx.db.query("grantResolveCache").collect());
  const links = await t.run(async (ctx) => ctx.db.query("grantResolveCacheWorkspaces").collect());
  expect(rows.some((row) => row.workspaces.some((workspace) => workspace.workspaceId === crew))).toBe(false);
  expect(links.some((link) => link.workspaceId === crew)).toBe(false);
  expect(rows.some((row) => row.userId === bob)).toBe(true);
  const again = await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }));
  expect(again.session).not.toBeNull();
  expect(JSON.stringify(again.session)).not.toContain("crew");
});
