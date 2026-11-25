/**
 * `/gateway/time-zone` — THE OWNER'S ZONE, FOR DATE PROPERTIES, AND NOTHING ELSE.
 *
 * The gateway writes a note's `date created` and `date modified` in its workspace owner's zone (Dev2, 2026-11-10).
 * Proved here:
 *
 *  1. A token's own workspace answers its owner's zone; a member of a shared workspace gets the owner's, not theirs.
 *  2. A workspace the token does not reach, an unknown token, and an owner with no zone all answer `null`, the same.
 *
 *  3. `/gateway/binding` carries the same zone beside the binding, for the same token and workspace, so a save reads it
 *     from the binding its store opened from (`apps/mcp/src/http/routing.js`), and no binding means no zone.
 *
 * Sabotage: answering for the expected workspace without finding it in the grant's reach fails "another tenant's
 * workspace answers null"; reading the caller's own zone in the binding route fails case 3.
 */

import { describe, expect, test } from "vitest";
import { addMember, createUser, createWorkspace, gatewayPost, seedStorageBinding } from "../fixtures.helpers";
import { ACCESS_A, ACCESS_B, bodyOf, registerClient, seedConnectedClient, token, twoConnectedTenants } from "./fixtures.helpers";

async function zoneOf(t: Parameters<typeof gatewayPost>[0], accessToken: string, expectedWorkspaceId: string) {
  const response = await gatewayPost(t, "/gateway/time-zone", { accessToken, expectedWorkspaceId });
  expect(response.status).toBe(200);
  return (await bodyOf(response)).timeZone;
}

describe("/gateway/time-zone", () => {
  test("a personal workspace answers its owner's zone", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    expect(await zoneOf(t, ACCESS_A, aliceWs)).toBe(null);
    await t.run((ctx) => ctx.db.insert("accountTimeZones", { userId: alice, timeZone: "America/Chicago", updatedAt: Date.now() }));
    expect(await zoneOf(t, ACCESS_A, aliceWs)).toBe("America/Chicago");
  });

  test("another tenant's workspace and an unknown token answer null", async () => {
    const { t, bob, aliceWs, bobWs } = await twoConnectedTenants();
    await t.run((ctx) => ctx.db.insert("accountTimeZones", { userId: bob, timeZone: "Europe/Paris", updatedAt: Date.now() }));
    expect(await zoneOf(t, ACCESS_A, bobWs)).toBe(null);
    expect(await zoneOf(t, token("nobody_at_all"), bobWs)).toBe(null);
    expect(await zoneOf(t, ACCESS_B, bobWs)).toBe("Europe/Paris");
    expect(await zoneOf(t, ACCESS_B, aliceWs)).toBe(null);
  });

  test("a member of a shared workspace gets the owner's zone, not their own", async () => {
    const { t, alice } = await twoConnectedTenants();
    const member = await createUser(t, "member-zone@example.invalid");
    const shared = await createWorkspace(t, alice, "zone-team", { kind: "shared" });
    await addMember(t, shared, member, "member", alice);
    const MEMBER = token("zone_member");
    await registerClient(t, "mcp_client_zone");
    await seedConnectedClient(t, { workspaceId: shared, userId: member, clientId: "mcp_client_zone", accessToken: MEMBER });
    await t.run(async (ctx) => {
      await ctx.db.insert("accountTimeZones", { userId: alice, timeZone: "America/Los_Angeles", updatedAt: Date.now() });
      await ctx.db.insert("accountTimeZones", { userId: member, timeZone: "Asia/Tokyo", updatedAt: Date.now() });
    });
    expect(await zoneOf(t, MEMBER, shared)).toBe("America/Los_Angeles");
  });

  test("/gateway/binding carries the zone /gateway/time-zone answers the same token, and none without a binding", async () => {
    const { t, alice, bob, aliceWs, bobWs } = await twoConnectedTenants();
    const boundZone = async (accessToken: string, expectedWorkspaceId: string) => {
      const response = await gatewayPost(t, "/gateway/binding", { accessToken, expectedWorkspaceId });
      expect(response.status).toBe(200);
      return await bodyOf(response);
    };
    // An owner who never set one: null, said, not left out.
    const before = await boundZone(ACCESS_A, aliceWs);
    expect(before.binding).not.toBeNull();
    expect(before).toHaveProperty("ownerTimeZone", null);
    expect(await zoneOf(t, ACCESS_A, aliceWs)).toBe(null);
    await t.run(async (ctx) => {
      await ctx.db.insert("accountTimeZones", { userId: alice, timeZone: "America/Chicago", updatedAt: Date.now() });
      await ctx.db.insert("accountTimeZones", { userId: bob, timeZone: "Europe/Paris", updatedAt: Date.now() });
    });
    expect((await boundZone(ACCESS_A, aliceWs)).ownerTimeZone).toBe(await zoneOf(t, ACCESS_A, aliceWs));
    expect((await boundZone(ACCESS_A, aliceWs)).ownerTimeZone).toBe("America/Chicago");
    // Another tenant's workspace: no binding, and no zone beside it.
    const refused = await boundZone(ACCESS_A, bobWs);
    expect(refused.binding).toBeNull();
    expect(refused).not.toHaveProperty("ownerTimeZone");

    // A member of a shared workspace: its owner's zone, not theirs, exactly as the zone route says.
    const member = await createUser(t, "member-bound-zone@example.invalid");
    const shared = await createWorkspace(t, alice, "zone-bound-team", { kind: "shared" });
    await addMember(t, shared, member, "member", alice);
    await seedStorageBinding(t, { workspaceId: shared, boundBy: alice, status: "connected" });
    const MEMBER = token("zone_bound_member");
    await registerClient(t, "mcp_client_bound_zone");
    await seedConnectedClient(t, { workspaceId: shared, userId: member, clientId: "mcp_client_bound_zone", accessToken: MEMBER });
    await t.run((ctx) => ctx.db.insert("accountTimeZones", { userId: member, timeZone: "Asia/Tokyo", updatedAt: Date.now() }));
    const bound = await boundZone(MEMBER, shared);
    expect(bound.binding).not.toBeNull();
    expect(bound.ownerTimeZone).toBe("America/Chicago");
    expect(bound.ownerTimeZone).toBe(await zoneOf(t, MEMBER, shared));
  });
});
