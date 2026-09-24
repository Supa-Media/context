import { describe, expect, test } from "vitest";
import { hashToken } from "../../functions/lib/crypto";
import {
  gatewayPost,
  type TestConvex,
} from "../fixtures.helpers";
import {
  token,
  ACCESS_A,
  REFRESH_A,
  ACCESS_A_SIBLING,
  CLIENT_A,
  CLIENT_A_SIBLING,
  seedConnectedClient,
  twoConnectedTenants,
  danglingWorkspaceId,
  removeMembership,
  bodyOf,
} from "./fixtures.helpers";

/* 7. /gateway/grants/create                                                  */
/* -------------------------------------------------------------------------- */

describe("/gateway/grants/create", () => {
  const FRESH_ACCESS = token("freshly_minted");
  const FRESH_REFRESH = `crt_freshly_minted_${"0".repeat(16)}`;

  async function create(
    t: TestConvex,
    overrides: Record<string, unknown> = {},
  ): Promise<Response> {
    return await gatewayPost(t, "/gateway/grants/create", {
      clientId: CLIENT_A,
      scopes: ["context:read", "context:write"],
      hashedRefreshToken: await hashToken(FRESH_REFRESH),
      hashedAccessToken: await hashToken(FRESH_ACCESS),
      accessTokenExpiresAt: Date.now() + 3_600_000,
      ...overrides,
    });
  }

  test("a grant created here resolves at /gateway/session immediately", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const created = await bodyOf(
      await create(t, { workspaceId: aliceWs, userId: alice }),
    );
    expect(typeof created.grantId).toBe("string");

    const session = await bodyOf(
      await gatewayPost(t, "/gateway/session", { accessToken: FRESH_ACCESS }),
    );
    expect((session.session as { grantId: string }).grantId).toBe(created.grantId);
    expect((session.session as { defaultWorkspaceId: string }).defaultWorkspaceId).toBe(
      aliceWs,
    );
  });

  test("re-checks membership: a code can outlive the moment it was issued", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await removeMembership(t, aliceWs, alice);

    const response = await create(t, { workspaceId: aliceWs, userId: alice });
    expect(response.status).toBe(400);
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/session", { accessToken: FRESH_ACCESS }),
      ),
    ).toEqual({ session: null });
  });

  test("refuses a workspace the user never belonged to, and a workspace id that is not one", async () => {
    const { t, alice, bobWs } = await twoConnectedTenants();
    const dangling = await danglingWorkspaceId(t);
    for (const workspaceId of [bobWs, dangling, "not-an-id", ""]) {
      const response = await create(t, { workspaceId, userId: alice });
      expect(response.status, `${workspaceId} was accepted`).toBe(400);
    }
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("oauthGrants")
          .withIndex("by_access_token", (q) => q.eq("hashedAccessToken", undefined))
          .collect(),
      ),
    ).toEqual([]);
  });

  test("refuses a client nobody registered, and a token that is not a hash", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    expect(
      (await create(t, { workspaceId: aliceWs, userId: alice, clientId: "ghost" }))
        .status,
    ).toBe(400);
    for (const bad of ["", "not-a-hash", "A".repeat(64), "a".repeat(63)]) {
      expect(
        (
          await create(t, {
            workspaceId: aliceWs,
            userId: alice,
            hashedRefreshToken: bad,
          })
        ).status,
        `${bad} was accepted as a refresh hash`,
      ).toBe(400);
      expect(
        (
          await create(t, {
            workspaceId: aliceWs,
            userId: alice,
            hashedAccessToken: bad,
          })
        ).status,
        `${bad} was accepted as an access hash`,
      ).toBe(400);
    }
  });

  test("a grant cannot be created without an access token to resolve it by", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const response = await gatewayPost(t, "/gateway/grants/create", {
      workspaceId: aliceWs,
      userId: alice,
      clientId: CLIENT_A,
      scopes: ["context:read"],
      hashedRefreshToken: await hashToken(FRESH_REFRESH),
    });
    expect(response.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. /gateway/grants/rotate                                                  */
/* -------------------------------------------------------------------------- */

describe("/gateway/grants/rotate", () => {
  const NEXT_ACCESS = token("rotated_access");
  const NEXT_REFRESH = `crt_rotated_refresh_${"0".repeat(14)}`;

  async function rotate(
    t: TestConvex,
    overrides: Record<string, unknown> = {},
  ): Promise<Response> {
    return await gatewayPost(t, "/gateway/grants/rotate", {
      refreshToken: REFRESH_A,
      clientId: CLIENT_A,
      newHashedRefreshToken: await hashToken(NEXT_REFRESH),
      newHashedAccessToken: await hashToken(NEXT_ACCESS),
      accessTokenExpiresAt: Date.now() + 3_600_000,
      scopes: null,
      ...overrides,
    });
  }

  test("rotates both halves in one step", async () => {
    const { t, alice, aliceWs, grantA } = await twoConnectedTenants();
    const body = await bodyOf(await rotate(t));
    expect(body.grant).toEqual({
      grantId: grantA,
      workspaceId: aliceWs,
      userId: alice,
      clientId: CLIENT_A,
      scopes: ["context:read", "context:write"],
    });

    // The new access token works…
    expect(
      (
        await bodyOf(
          await gatewayPost(t, "/gateway/session", { accessToken: NEXT_ACCESS }),
        )
      ).session,
    ).not.toBeNull();
    // …and the old one does not.
    expect(
      await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A })),
    ).toEqual({ session: null });
  });

  /**
   * The property OAuth 2.1 §4.3.1 is actually asking for. A replayed refresh
   * token means two parties hold it; refusing the request would leave the
   * thief holding a working grant.
   */
  test("reusing a rotated-away refresh token revokes the whole grant", async () => {
    const { t, grantA } = await twoConnectedTenants();
    await rotate(t);

    const replay = await bodyOf(await rotate(t));
    expect(replay).toEqual({ grant: null });

    const grant = await t.run((ctx) => ctx.db.get(grantA));
    expect(grant?.status).toBe("revoked");
    expect(grant?.revokedAt).toBeGreaterThan(0);

    // The access token minted a moment ago dies with it.
    expect(
      await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: NEXT_ACCESS })),
    ).toEqual({ session: null });
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/binding", {
          accessToken: NEXT_ACCESS,
          expectedWorkspaceId: null,
        }),
      ),
    ).toEqual({ binding: null });
  });

  test("the reuse revocation is recorded, naming the reason and no token", async () => {
    const { t } = await twoConnectedTenants();
    await rotate(t);
    await rotate(t);

    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    const revocation = events.find(
      (event) => event.details?.reason === "refresh_token_reuse",
    );
    expect(revocation?.action).toBe("grant.revoked");
    expect(JSON.stringify(revocation)).not.toContain(REFRESH_A);
    expect(JSON.stringify(revocation)).not.toContain(await hashToken(REFRESH_A));
  });

  test("revoking the whole grant leaves its siblings alone", async () => {
    const { t, grantASibling } = await twoConnectedTenants();
    await rotate(t);
    await rotate(t);

    expect((await t.run((ctx) => ctx.db.get(grantASibling)))?.status).toBe("active");
    expect(
      (
        await bodyOf(
          await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A_SIBLING }),
        )
      ).session,
    ).not.toBeNull();
  });

  test("a client cannot rotate another client's grant", async () => {
    const { t, grantA } = await twoConnectedTenants();
    expect(await bodyOf(await rotate(t, { clientId: CLIENT_A_SIBLING }))).toEqual({
      grant: null,
    });
    // And the grant is untouched — a wrong clientId is not a leak signal.
    const grant = await t.run((ctx) => ctx.db.get(grantA));
    expect(grant?.status).toBe("active");
    expect(grant?.hashedRefreshToken).toBe(await hashToken(REFRESH_A));
  });

  test("scopes may only narrow, never widen", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const readOnly = token("read_only");
    const readOnlyRefresh = `crt_read_only_${"0".repeat(20)}`;
    await seedConnectedClient(t, {
      workspaceId: aliceWs,
      userId: alice,
      clientId: CLIENT_A_SIBLING,
      accessToken: readOnly,
      refreshToken: readOnlyRefresh,
      scopes: ["context:read"],
    });

    const widened = await bodyOf(
      await gatewayPost(t, "/gateway/grants/rotate", {
        refreshToken: readOnlyRefresh,
        clientId: CLIENT_A_SIBLING,
        newHashedRefreshToken: await hashToken("crt_widened_00000000000000000000"),
        newHashedAccessToken: await hashToken("cat_widened_00000000000000000000"),
        accessTokenExpiresAt: Date.now() + 3_600_000,
        scopes: ["context:read", "context:write"],
      }),
    );
    expect((widened.grant as { scopes: string[] }).scopes).toEqual(["context:read"]);
  });

  /**
   * Refresh is the one door into an existing grant that a client drives alone,
   * with no person present. If it could add `context:private`, every read-only
   * team-tier grant would be one token request away from full access.
   */
  test("a refresh cannot raise the privacy tier", async () => {
    const { t } = await twoConnectedTenants();
    const body = await bodyOf(
      await rotate(t, {
        scopes: ["context:read", "context:write", "context:private"],
      }),
    );
    // Intersected with what is held, which never included the tier scope.
    expect((body.grant as { scopes: string[] }).scopes).toEqual([
      "context:read",
      "context:write",
    ]);
  });

  test("a narrowing request is honoured", async () => {
    const { t } = await twoConnectedTenants();
    const body = await bodyOf(await rotate(t, { scopes: ["context:read"] }));
    expect((body.grant as { scopes: string[] }).scopes).toEqual(["context:read"]);
  });

  test("a revoked grant, an unknown token, and a removed member all refuse", async () => {
    const { t, alice, aliceWs, grantA } = await twoConnectedTenants();
    expect(
      await bodyOf(await rotate(t, { refreshToken: "not-a-refresh-token" })),
    ).toEqual({ grant: null });

    await removeMembership(t, aliceWs, alice);
    expect(await bodyOf(await rotate(t))).toEqual({ grant: null });
    // A membership refusal must not rotate the stored hashes either.
    expect((await t.run((ctx) => ctx.db.get(grantA)))?.hashedRefreshToken).toBe(
      await hashToken(REFRESH_A),
    );

    await t.run((ctx) => ctx.db.patch(grantA, { status: "revoked" }));
    expect(await bodyOf(await rotate(t))).toEqual({ grant: null });
  });

  test("refuses to record a new token that is not a hash", async () => {
    const { t } = await twoConnectedTenants();
    expect(
      (await rotate(t, { newHashedRefreshToken: "crt_the_actual_plaintext" })).status,
    ).toBe(400);
    expect(
      (await rotate(t, { newHashedAccessToken: "cat_the_actual_plaintext" })).status,
    ).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* 9. /gateway/grants/revoke                                                  */
/* -------------------------------------------------------------------------- */

describe("/gateway/grants/revoke", () => {
  test("revokes exactly one client and leaves its siblings working", async () => {
    const { t, grantA, grantASibling } = await twoConnectedTenants();
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/grants/revoke", {
        token: ACCESS_A_SIBLING,
        tokenType: "access",
        clientId: CLIENT_A_SIBLING,
      }),
    );
    expect(body).toEqual({ revoked: true });

    expect((await t.run((ctx) => ctx.db.get(grantASibling)))?.status).toBe("revoked");
    expect((await t.run((ctx) => ctx.db.get(grantA)))?.status).toBe("active");
    expect(
      (await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A })))
        .session,
    ).not.toBeNull();
  });

  test("revokes by refresh token too", async () => {
    const { t, grantA } = await twoConnectedTenants();
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/grants/revoke", {
          token: REFRESH_A,
          tokenType: "refresh",
          clientId: CLIENT_A,
        }),
      ),
    ).toEqual({ revoked: true });
    expect((await t.run((ctx) => ctx.db.get(grantA)))?.status).toBe("revoked");
  });

  test("a client may not revoke somebody else's grant", async () => {
    const { t, grantA } = await twoConnectedTenants();
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/grants/revoke", {
          token: ACCESS_A,
          tokenType: "access",
          clientId: CLIENT_A_SIBLING,
        }),
      ),
    ).toEqual({ revoked: false });
    expect((await t.run((ctx) => ctx.db.get(grantA)))?.status).toBe("active");
  });

  test("an unknown token still answers 200, as RFC 7009 requires", async () => {
    const { t } = await twoConnectedTenants();
    const response = await gatewayPost(t, "/gateway/grants/revoke", {
      token: "not-a-token",
      tokenType: "access",
      clientId: CLIENT_A,
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ revoked: false });
  });

  test("revoking twice is not an error, and is not a second event", async () => {
    const { t } = await twoConnectedTenants();
    const revoke = () =>
      gatewayPost(t, "/gateway/grants/revoke", {
        token: ACCESS_A,
        tokenType: "access",
        clientId: CLIENT_A,
      });
    expect(await bodyOf(await revoke())).toEqual({ revoked: true });
    expect(await bodyOf(await revoke())).toEqual({ revoked: false });

    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(events.filter((e) => e.action === "grant.revoked")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
