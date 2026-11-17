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
 * Sabotage: skip the cache read in `loadGrantWorkspaces` and the tampered
 * snapshot shows up on the second session.
 */

import { expect, test } from "vitest";
import { ACCESS_A, bodyOf, removeMembership, twoConnectedTenants } from "./fixtures.helpers";
import { gatewayPost } from "../fixtures.helpers";

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
