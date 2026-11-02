/**
 * A switched person's AI client connections, held by their person object (`functions/accessConnections.ts`,
 * `functions/controlPlane.ts` rotate and revoke, `functions/accessMirror.ts` `rotate_connection`, and the gateway
 * routes that answer with the person). Covers who is switched, that a connection is refused unless it is held, that
 * refresh reuse and revocation are left to the object, and that the copy behind it follows the object's rotation.
 *
 * Sabotage, each confirmed to fail a case here: let `createHeld` run for an unswitched person; let `rotateGrant` write
 * for a switched grant; let `revokeGrantByToken` revoke a switched grant in Convex; drop the personal-workspace check
 * from `rotate_connection`.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { clampScopes } from "../functions/lib/consentScopes";
import { hashToken } from "../functions/lib/crypto";
import { createUser, createWorkspace, captureError, errorCode, gatewayPost, setupTest, type TestConvex } from "./fixtures.helpers";
import { registerClient } from "./controlPlane/fixtures.helpers";

const CLIENT = "mcp_client_held";
const REDIRECT_URI = "https://client.example/callback";
const ACCESS = `cat_${"x".repeat(43)}`;
const REFRESH = `crt_${"x".repeat(43)}`;
const CODE = `code_${"y".repeat(43)}`;
const HOUR = 3_600_000;

async function world() {
  const t = setupTest();
  const alice = await createUser(t, "connections-alice@example.com");
  const aliceWs = await createWorkspace(t, alice, "connections-alice");
  const bob = await createUser(t, "connections-bob@example.com");
  const bobWs = await createWorkspace(t, bob, "connections-bob");
  expect((await registerClient(t, CLIENT)).status).toBe(200);
  return { t, alice, aliceWs, bob, bobWs };
}

/** Switch a person: their personal workspace's `personAccess` is `object`. */
async function switchPerson(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
  await t.run((ctx) => ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "bucket", since: 0, personAccess: "object", personAccessSince: 0 }));
}

/** A live grant inserted directly, as the object would have left one. */
async function insertGrant(
  t: TestConvex,
  row: { workspaceId: Id<"workspaces">; userId: Id<"users">; hashedRefreshToken: string; hashedAccessToken?: string; previousHashedRefreshToken?: string },
): Promise<Id<"oauthGrants">> {
  return await t.run((ctx) =>
    ctx.db.insert("oauthGrants", { ...row, clientId: CLIENT, scopes: ["context:read", "context:write"], status: "active", createdAt: Date.now() }),
  );
}

const grantRow = (t: TestConvex, grantId: Id<"oauthGrants">) => t.run((ctx) => ctx.db.get(grantId));

const createArgs = (workspaceId: Id<"workspaces">, userId: Id<"users">, hashedRefreshToken: string, hashedAccessToken: string) => ({
  workspaceId: String(workspaceId),
  userId: String(userId),
  clientId: CLIENT,
  scopes: ["context:read", "context:write", "context:read"],
  hashedRefreshToken,
  hashedAccessToken,
  accessTokenExpiresAt: Date.now() + HOUR,
});

describe("who is switched", () => {
  test("personOf answers convex for an unswitched person and object once their personal workspace is switched", async () => {
    const { t, alice, aliceWs } = await world();
    expect(await t.query(internal.functions.accessConnections.personOf, { userId: alice })).toEqual({ personalWorkspaceId: aliceWs, access: "convex" });
    await switchPerson(t, aliceWs);
    expect(await t.query(internal.functions.accessConnections.personOf, { userId: alice })).toEqual({ personalWorkspaceId: aliceWs, access: "object" });
  });
});

describe("createHeld", () => {
  test("refuses an unswitched person and writes no grant", async () => {
    const { t, alice, aliceWs } = await world();
    const args = createArgs(aliceWs, alice, await hashToken(REFRESH), await hashToken(ACCESS));
    const error = await captureError(() => t.mutation(internal.functions.accessConnections.createHeld, args));
    expect(errorCode(error)).toBe("NOT_SWITCHED");
    expect(await t.run((ctx) => ctx.db.query("oauthGrants").collect())).toEqual([]);
  });

  test("a switched person's grant comes back with its connection row, clamped as createGrant clamps, and is not written behind to the outbox", async () => {
    const { t, alice, aliceWs } = await world();
    await switchPerson(t, aliceWs);
    const hashedRefreshToken = await hashToken(REFRESH);
    const hashedAccessToken = await hashToken(ACCESS);
    const requested = ["context:read", "context:write", "context:read"];
    const { grantId, connection } = await t.mutation(
      internal.functions.accessConnections.createHeld,
      createArgs(aliceWs, alice, hashedRefreshToken, hashedAccessToken),
    );

    expect(connection).toMatchObject({
      grantId: String(grantId),
      tokenHash: hashedAccessToken,
      refreshHash: hashedRefreshToken,
      status: "active",
      scopes: clampScopes(requested, "owner"),
    });
    const stored = await grantRow(t, grantId);
    expect(stored?.scopes).toEqual(clampScopes(requested, "owner"));
    expect(stored?.status).toBe("active");
    expect(await t.run((ctx) => ctx.db.query("accessObjectOutbox").collect())).toEqual([]);
  });

  test("refuses the texting client even for a switched person", async () => {
    const { t, alice, aliceWs } = await world();
    await switchPerson(t, aliceWs);
    const args = { ...createArgs(aliceWs, alice, await hashToken(REFRESH), await hashToken(ACCESS)), clientId: "context_texts" };
    expect(errorCode(await captureError(() => t.mutation(internal.functions.accessConnections.createHeld, args)))).toBe("NOT_SWITCHED");
    expect(await t.run((ctx) => ctx.db.query("oauthGrants").collect())).toEqual([]);
  });
});

describe("/gateway/grants/create with heldBy object", () => {
  test("answers grantId and connection for a switched person, and 400 for an unswitched one", async () => {
    const { t, alice, aliceWs, bob, bobWs } = await world();
    await switchPerson(t, aliceWs);
    const body = (workspaceId: Id<"workspaces">, userId: Id<"users">) => ({
      ...createArgs(workspaceId, userId, `${"c".repeat(64)}`, `${"d".repeat(64)}`),
      heldBy: "object",
    });

    const held = await gatewayPost(t, "/gateway/grants/create", body(aliceWs, alice));
    expect(held.status).toBe(200);
    const answer = (await held.json()) as { grantId: string; connection: { grantId: string } };
    expect(typeof answer.grantId).toBe("string");
    expect(answer.connection.grantId).toBe(answer.grantId);

    expect((await gatewayPost(t, "/gateway/grants/create", body(bobWs, bob))).status).toBe(400);
  });
});

describe("rotateGrant for a switched grant", () => {
  test("returns null and leaves the grant's refresh hash alone", async () => {
    const { t, alice, aliceWs } = await world();
    await switchPerson(t, aliceWs);
    const current = await hashToken(REFRESH);
    const grantId = await insertGrant(t, { workspaceId: aliceWs, userId: alice, hashedRefreshToken: current, hashedAccessToken: await hashToken(ACCESS) });

    const result = await t.mutation(internal.functions.controlPlane.rotateGrant, {
      hashedRefreshToken: current,
      clientId: CLIENT,
      newHashedRefreshToken: await hashToken(`${REFRESH}-next`),
      newHashedAccessToken: await hashToken(`${ACCESS}-next`),
      accessTokenExpiresAt: Date.now() + HOUR,
      scopes: null,
    });
    expect(result).toBeNull();
    expect((await grantRow(t, grantId))?.hashedRefreshToken).toBe(current);
  });

  test("presenting the spent refresh token does not revoke a switched grant, though it does for an unswitched one", async () => {
    const { t, alice, aliceWs, bob, bobWs } = await world();
    await switchPerson(t, aliceWs);
    // Distinct pairs: the reuse lookup is unique per previous hash.
    const spent = await hashToken(`${REFRESH}-spent`);
    const current = await hashToken(`${REFRESH}-current`);
    const plainSpent = await hashToken(`${REFRESH}-plain-spent`);
    const plainCurrent = await hashToken(`${REFRESH}-plain-current`);
    const switchedGrant = await insertGrant(t, { workspaceId: aliceWs, userId: alice, hashedRefreshToken: current, previousHashedRefreshToken: spent });
    const plainGrant = await insertGrant(t, { workspaceId: bobWs, userId: bob, hashedRefreshToken: plainCurrent, previousHashedRefreshToken: plainSpent });
    const rotate = (hashedRefreshToken: string) =>
      t.mutation(internal.functions.controlPlane.rotateGrant, {
        hashedRefreshToken,
        clientId: CLIENT,
        newHashedRefreshToken: "e".repeat(64),
        newHashedAccessToken: "f".repeat(64),
        accessTokenExpiresAt: Date.now() + HOUR,
        scopes: null,
      });

    expect(await rotate(spent)).toBeNull();
    expect((await grantRow(t, switchedGrant))?.status).toBe("active");
    // The contrast: the same presentation on an unswitched person's grant is reuse, and it revokes.
    expect(await rotate(plainSpent)).toBeNull();
    expect((await grantRow(t, plainGrant))?.status).toBe("revoked");
  });
});

describe("revocation of a switched grant", () => {
  test("/gateway/grants/revoke answers held with the grant and personal workspace, and leaves it active", async () => {
    const { t, alice, aliceWs } = await world();
    await switchPerson(t, aliceWs);
    const grantId = await insertGrant(t, { workspaceId: aliceWs, userId: alice, hashedRefreshToken: await hashToken(REFRESH), hashedAccessToken: await hashToken(ACCESS) });

    const response = await gatewayPost(t, "/gateway/grants/revoke", { token: ACCESS, tokenType: "access", clientId: CLIENT });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: false, held: { grantId: String(grantId), personalWorkspaceId: String(aliceWs) } });
    expect((await grantRow(t, grantId))?.status).toBe("active");
  });

  test("/gateway/grants/revoke still revokes an unswitched person's grant in Convex", async () => {
    const { t, bob, bobWs } = await world();
    const grantId = await insertGrant(t, { workspaceId: bobWs, userId: bob, hashedRefreshToken: await hashToken(REFRESH), hashedAccessToken: await hashToken(ACCESS) });

    const response = await gatewayPost(t, "/gateway/grants/revoke", { token: ACCESS, tokenType: "access", clientId: CLIENT });
    expect(await response.json()).toEqual({ revoked: true });
    expect((await grantRow(t, grantId))?.status).toBe("revoked");
  });
});

describe("accessMirror rotate_connection", () => {
  const OLD = "a".repeat(64);
  const NEW_REFRESH = "b".repeat(64);
  const NEW_ACCESS = "c".repeat(64);

  test("takes the object's new pair, keeps the spent refresh hash, is idempotent, and refuses another person's workspace", async () => {
    const { t, alice, aliceWs, bobWs } = await world();
    await switchPerson(t, aliceWs);
    const grantId = await insertGrant(t, { workspaceId: aliceWs, userId: alice, hashedRefreshToken: OLD });
    const change = { op: "rotate_connection" as const, grantId: String(grantId), tokenHash: NEW_ACCESS, refreshHash: NEW_REFRESH, expiresAt: Date.now() + HOUR, scopes: ["context:read"], at: 2 };

    expect(await t.mutation(internal.functions.accessMirror.apply, { workspaceId: bobWs, change })).toEqual({ applied: false, refused: "WRONG_WORKSPACE" });
    expect((await grantRow(t, grantId))?.hashedRefreshToken).toBe(OLD);

    expect(await t.mutation(internal.functions.accessMirror.apply, { workspaceId: aliceWs, change })).toEqual({ applied: true });
    const after = await grantRow(t, grantId);
    expect(after).toMatchObject({ hashedRefreshToken: NEW_REFRESH, previousHashedRefreshToken: OLD, hashedAccessToken: NEW_ACCESS, scopes: ["context:read"] });

    expect(await t.mutation(internal.functions.accessMirror.apply, { workspaceId: aliceWs, change })).toEqual({ applied: false });
    expect(await grantRow(t, grantId)).toEqual(after);
  });
});

describe("/gateway/codes/consume", () => {
  test("carries the person, with access object, for a switched user", async () => {
    const { t, alice, aliceWs } = await world();
    await switchPerson(t, aliceWs);
    const hashedCode = await hashToken(CODE);
    await t.run((ctx) =>
      ctx.db.insert("oauthAuthorizations", {
        requestId: "req_held_connections",
        clientId: CLIENT,
        redirectUri: REDIRECT_URI,
        state: null,
        codeChallenge: "g".repeat(43),
        codeChallengeMethod: "S256",
        scope: "context:read",
        grantedScope: "context:read",
        resource: null,
        requestedWorkspaceSlug: null,
        status: "approved",
        hashedCode,
        workspaceId: aliceWs,
        userId: alice,
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600_000,
        createdAt: Date.now(),
      }),
    );

    const response = await gatewayPost(t, "/gateway/codes/consume", { code: CODE, clientId: CLIENT });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorization: { workspaceId: string; person: unknown } };
    expect(body.authorization.person).toEqual({ personalWorkspaceId: aliceWs, access: "object" });
  });
});
