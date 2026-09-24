import { describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api } from "../../_generated/api";
import { hashToken } from "../../functions/lib/crypto";
import {
  TEST_GATEWAY_SECRET,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  gatewayPost,
  responseFingerprint,
  setupTest,
} from "../fixtures.helpers";
import {
  token,
  ACCESS_A,
  ACCESS_B,
  ACCESS_A_SIBLING,
  CLIENT_A,
  CLIENT_A_SIBLING,
  registerClient,
  seedConnectedClient,
  twoConnectedTenants,
  removeMembership,
  bodyOf,
} from "./fixtures";

/* -------------------------------------------------------------------------- */
/* 1. The gateway secret                                                      */
/* -------------------------------------------------------------------------- */

describe("the gateway secret is necessary", () => {
  test("a request with no Authorization header is refused, on every route", async () => {
    const { t } = await twoConnectedTenants();
    for (const path of [
      "/gateway/session",
      "/gateway/sessions/by-grant",
      "/gateway/binding",
      "/gateway/provider",
      "/gateway/clients/register",
      "/gateway/clients/get",
      "/gateway/authorize/start",
      "/gateway/codes/consume",
      "/gateway/grants/create",
      "/gateway/grants/rotate",
      "/gateway/grants/revoke",
    ]) {
      const response = await gatewayPost(t, path, { accessToken: ACCESS_A }, {
        secret: null,
      });
      expect(response.status, `${path} answered without the gateway secret`).toBe(401);
    }
  });

  test("a wrong secret is refused, and identically to no secret at all", async () => {
    const { t } = await twoConnectedTenants();
    const wrong = await gatewayPost(
      t,
      "/gateway/session",
      { accessToken: ACCESS_A },
      { secret: "not-the-gateway-secret" },
    );
    const absent = await gatewayPost(
      t,
      "/gateway/session",
      { accessToken: ACCESS_A },
      { secret: null },
    );

    expect(wrong.status).toBe(401);
    expect(await responseFingerprint(wrong)).toBe(await responseFingerprint(absent));
  });

  test("a secret of the wrong length is refused without leaking that it was wrong", async () => {
    const { t } = await twoConnectedTenants();
    for (const secret of ["", "t", `${TEST_GATEWAY_SECRET}x`, TEST_GATEWAY_SECRET.slice(0, -1)]) {
      const response = await gatewayPost(
        t,
        "/gateway/session",
        { accessToken: ACCESS_A },
        { secret },
      );
      expect(response.status, `"${secret.slice(0, 4)}…" was accepted`).toBe(401);
    }
  });

  test("a refusal names nothing — not the route, not the workspace, not the secret", async () => {
    const { t } = await twoConnectedTenants();
    const response = await gatewayPost(
      t,
      "/gateway/binding",
      { accessToken: ACCESS_A, expectedWorkspaceId: null },
      { secret: "wrong" },
    );
    const text = await response.text();
    expect(text).not.toContain(TEST_GATEWAY_SECRET);
    expect(text).not.toContain("alfa");
    expect(text).not.toContain("tenant-a");
    expect(JSON.parse(text)).toEqual({ error: "unauthorized" });
  });
});

describe("the gateway secret is never sufficient", () => {
  test("it opens no credential on its own", async () => {
    const { t } = await twoConnectedTenants();
    const response = await gatewayPost(t, "/gateway/binding", {
      accessToken: "not-a-token",
      expectedWorkspaceId: null,
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ binding: null });
  });

  test("a session carries the client's own name, for the activity file", async () => {
    const { t } = await twoConnectedTenants();
    const response = await gatewayPost(t, "/gateway/session", {
      accessToken: ACCESS_A,
    });
    const body = (await bodyOf(response)) as {
      session: { clientId: string; clientName: string | null };
    };
    // The one thing a person recognises. Without it a line in `activity.md`
    // can only name a registration id, and "mcp_client_alpha added three
    // notes" is not a sentence anybody reads twice.
    expect(body.session.clientId).toBe(CLIENT_A);
    expect(body.session.clientName).toBe(`Client ${CLIENT_A}`);
  });

  test("it resolves no session on its own", async () => {
    const { t } = await twoConnectedTenants();
    const response = await gatewayPost(t, "/gateway/session", {
      accessToken: "not-a-token",
    });
    expect(await bodyOf(response)).toEqual({ session: null });
  });

  test("it never appears in a response body", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const said: string[] = [];
    for (const [path, body] of [
      ["/gateway/session", { accessToken: ACCESS_A }],
      ["/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }],
      ["/gateway/clients/get", { clientId: CLIENT_A }],
      ["/gateway/codes/consume", { code: "nope", clientId: CLIENT_A }],
      ["/gateway/grants/revoke", { token: "nope", tokenType: "access", clientId: CLIENT_A }],
    ] as const) {
      said.push(await (await gatewayPost(t, path, body)).text());
    }
    expect(said.join("\n")).not.toContain(TEST_GATEWAY_SECRET);
  });

  test("it never appears in an audit record", async () => {
    const { t, aliceWs, alice } = await twoConnectedTenants();
    await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A });
    await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    await gatewayPost(t, "/gateway/grants/create", {
      workspaceId: aliceWs,
      userId: alice,
      clientId: CLIENT_A,
      scopes: ["context:read"],
      hashedRefreshToken: await hashToken("crt_fresh_0000000000000000000000"),
      hashedAccessToken: await hashToken("cat_fresh_0000000000000000000000"),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });
    await gatewayPost(t, "/gateway/grants/revoke", {
      token: ACCESS_A_SIBLING,
      tokenType: "access",
      clientId: CLIENT_A_SIBLING,
    });

    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(TEST_GATEWAY_SECRET);
    // …and no token, hashed or otherwise, either.
    expect(serialized).not.toContain(ACCESS_A);
    expect(serialized).not.toContain(await hashToken(ACCESS_A));
  });
});

/* -------------------------------------------------------------------------- */
/* 2. /gateway/session                                                        */
/* -------------------------------------------------------------------------- */

describe("/gateway/session", () => {
  test("resolves live relay grant metadata and preserves invalid batch slots", async () => {
    const { t, aliceWs, grantA } = await twoConnectedTenants();
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/sessions/by-grant", {
        expectedWorkspaceId: aliceWs,
        grantIds: [grantA, "not-a-grant-id", aliceWs],
      }),
    );

    expect(body.sessions).toEqual([
      {
        grantId: grantA,
        workspaceId: aliceWs,
        scopes: ["context:read", "context:write"],
        role: "owner",
        kind: "personal",
      },
      null,
      null,
    ]);
  });

  test("rechecks grant state and rejects malformed batches", async () => {
    const { t, aliceWs, grantA } = await twoConnectedTenants();
    await t.run((ctx) => ctx.db.patch(grantA, { status: "revoked" }));

    const revoked = await bodyOf(
      await gatewayPost(t, "/gateway/sessions/by-grant", {
        expectedWorkspaceId: aliceWs,
        grantIds: [grantA],
      }),
    );
    expect(revoked).toEqual({ sessions: [null] });

    const duplicateResponse = await gatewayPost(t, "/gateway/sessions/by-grant", {
        expectedWorkspaceId: aliceWs,
        grantIds: [grantA, grantA],
      });
    expect(duplicateResponse.status).toBe(400);
    expect(await bodyOf(duplicateResponse)).toEqual({ error: "malformed_batch" });

    const oversizedResponse = await gatewayPost(t, "/gateway/sessions/by-grant", {
        expectedWorkspaceId: aliceWs,
        grantIds: Array.from({ length: 25 }, (_, index) => `grant-${index}`),
      });
    expect(oversizedResponse.status).toBe(400);
    expect(await bodyOf(oversizedResponse)).toEqual({ error: "malformed_batch" });
  });

  test("requires a live target membership, client and expiry", async () => {
    const { t, alice, bob, aliceWs, bobWs, grantA } = await twoConnectedTenants();

    // The grant's own user is not a member of Bob's context yet.
    expect(
      (await bodyOf(
        await gatewayPost(t, "/gateway/sessions/by-grant", {
          expectedWorkspaceId: bobWs,
          grantIds: [grantA],
        }),
      )).sessions,
    ).toEqual([null]);

    await addMember(t, bobWs, alice, "member", bob);
    const shared = await bodyOf(
      await gatewayPost(t, "/gateway/sessions/by-grant", {
        expectedWorkspaceId: bobWs,
        grantIds: [grantA],
      }),
    );
    expect(shared.sessions).toEqual([
      {
        grantId: grantA,
        workspaceId: bobWs,
        scopes: ["context:read", "context:write"],
        role: "member",
        kind: "personal",
      },
    ]);

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", bobWs).eq("userId", alice),
        )
        .unique();
      if (membership !== null) await ctx.db.delete(membership._id);
    });
    expect(
      (await bodyOf(
        await gatewayPost(t, "/gateway/sessions/by-grant", {
          expectedWorkspaceId: bobWs,
          grantIds: [grantA],
        }),
      )).sessions,
    ).toEqual([null]);

    const expiredGrant = await seedConnectedClient(t, {
      workspaceId: aliceWs,
      userId: alice,
      clientId: CLIENT_A,
      accessToken: token("expired_batch"),
      expiresAt: Date.now() - 1,
    });
    expect(
      (await bodyOf(
        await gatewayPost(t, "/gateway/sessions/by-grant", {
          expectedWorkspaceId: aliceWs,
          grantIds: [expiredGrant],
        }),
      )).sessions,
    ).toEqual([null]);

    await t.run(async (ctx) => {
      const client = await ctx.db
        .query("oauthClients")
        .withIndex("by_clientId", (q) => q.eq("clientId", CLIENT_A))
        .unique();
      if (client !== null) await ctx.db.delete(client._id);
    });
    expect(
      (await bodyOf(
        await gatewayPost(t, "/gateway/sessions/by-grant", {
          expectedWorkspaceId: aliceWs,
          grantIds: [grantA],
        }),
      )).sessions,
    ).toEqual([null]);
  });

  test("reports the pinned context as a member without console group clearance", async () => {
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
    const { t, alice, aliceWs, grantA } = await twoConnectedTenants();
    const staff = await createUser(t, "staff@example.invalid");
    const pinned = await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, {
      kind: "shared",
      displayName: "Context",
    });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/sessions/by-grant", {
        expectedWorkspaceId: pinned,
        grantIds: [grantA],
      }),
    );
    expect(body.sessions).toEqual([
      {
        grantId: grantA,
        workspaceId: pinned,
        scopes: ["context:read", "context:write"],
        role: "member",
        kind: "shared",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(aliceWs);
  });

  test("a console session carries live group names, while a narrow OAuth grant carries none", async () => {
    const t = setupTest();
    const owner = await createUser(t, "group-owner@example.invalid");
    const member = await createUser(t, "group-member@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "group-home", { kind: "shared" });
    await addMember(t, workspaceId, member, "member", owner);
    const group = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "readers",
    });
    await asUser(t, owner).mutation(api.functions.groups.addGroupMember, {
      workspaceId,
      groupId: group.groupId,
      userId: member,
    });

    const consoleGrant = await asUser(t, member).action(
      api.functions.agentGrant.mintConsoleGrant,
      { workspaceId },
    );
    const consoleSession = await bodyOf(
      await gatewayPost(t, "/gateway/session", { accessToken: consoleGrant.accessToken }),
    );
    expect((consoleSession.session as any).workspaces[0].grantedNames).toEqual([
      "group-home-readers",
    ]);
    const relayGrantId = (consoleSession.session as any).grantId as string;
    const relay = await bodyOf(
      await gatewayPost(t, "/gateway/sessions/by-grant", {
        expectedWorkspaceId: workspaceId,
        grantIds: [relayGrantId],
      }),
    );
    expect((relay.sessions as any[])[0].grantedNames).toEqual([
      "group-home-readers",
    ]);

    // The membership is read on every resolution. Removing it must retract the
    // live name from an already-issued console token on the next request.
    await asUser(t, owner).mutation(api.functions.groups.removeGroupMember, {
      workspaceId,
      groupId: group.groupId,
      userId: member,
    });
    const afterRemoval = await bodyOf(
      await gatewayPost(t, "/gateway/session", { accessToken: consoleGrant.accessToken }),
    );
    expect((afterRemoval.session as any).workspaces[0].grantedNames).toEqual([]);
    const relayAfterRemoval = await bodyOf(
      await gatewayPost(t, "/gateway/sessions/by-grant", {
        expectedWorkspaceId: workspaceId,
        grantIds: [relayGrantId],
      }),
    );
    expect((relayAfterRemoval.sessions as any[])[0].grantedNames).toEqual([]);

    // A normal OAuth grant may have the same person, workspace and role, but
    // its consent is narrower and must never acquire console-only group names.
    await registerClient(t, "narrow_group_client");
    const narrowToken = token("narrow_group");
    await seedConnectedClient(t, {
      workspaceId,
      userId: member,
      clientId: "narrow_group_client",
      accessToken: narrowToken,
      scopes: ["context:read"],
    });
    const narrowSession = await bodyOf(
      await gatewayPost(t, "/gateway/session", { accessToken: narrowToken }),
    );
    expect((narrowSession.session as any).workspaces[0].grantedNames).toBeUndefined();
  });

  test("resolves a live grant to the documented shape", async () => {
    const { t, alice, aliceWs, grantA } = await twoConnectedTenants();
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }),
    );
    const session = body.session as Record<string, unknown>;

    expect(session.grantId).toBe(grantA);
    expect(session.clientId).toBe(CLIENT_A);
    expect(session.actorUserId).toBe(alice);
    expect(session.scopes).toEqual(["context:read", "context:write"]);
    expect(typeof session.expiresAt).toBe("number");
    expect(session.defaultWorkspaceId).toBe(aliceWs);
    expect(session.workspaces).toEqual([
      { workspaceId: aliceWs, slug: "alfa", role: "owner", kind: "personal" },
    ]);
  });

  test("a session covers what its person is a member of, and never another tenant's", async () => {
    const { t, bobWs } = await twoConnectedTenants();
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }),
    );
    const workspaces = (body.session as { workspaces: { workspaceId: string }[] })
      .workspaces;
    expect(workspaces).toHaveLength(1);
    expect(workspaces.map((w) => w.workspaceId)).not.toContain(bobWs);
    expect(JSON.stringify(body)).not.toContain("alphabet");
  });

  /**
   * The widening, and the two things that did not widen with it.
   *
   * A grant covers every context its person is a live member of, so a client
   * connected once can address a workspace shared with its owner. What travels with
   * each entry is the **role in that context**, which is what the gateway
   * clamps scopes and the visibility tier to — reach is not permission — and
   * the grant's own context stays separately identified as the default, because
   * "which one did this person approve" and "which may this connection reach"
   * are two questions and one field cannot answer both.
   */
  test("a context shared with this person afterwards is in the set, with the role they hold there", async () => {
    const { t, alice, aliceWs, bobWs } = await twoConnectedTenants();
    await addMember(t, bobWs, alice, "member");

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }),
    );
    const session = body.session as {
      defaultWorkspaceId: string;
      workspaces: { workspaceId: string; slug: string; role: string; kind: string }[];
    };

    // No re-approval, no new grant: the membership row is the whole of it.
    expect(session.workspaces).toEqual([
      { workspaceId: aliceWs, slug: "alfa", role: "owner", kind: "personal" },
      { workspaceId: bobWs, slug: "alphabet", role: "member", kind: "personal" },
    ]);
    // And the context she approved is still the one an unaddressed call means.
    expect(session.defaultWorkspaceId).toBe(aliceWs);
  });

  test("stamps lastUsedAt, which is how a person spots a client they do not recognise", async () => {
    const { t, grantA } = await twoConnectedTenants();
    expect((await t.run((ctx) => ctx.db.get(grantA)))?.lastUsedAt).toBeUndefined();

    await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A });
    const grant = await t.run((ctx) => ctx.db.get(grantA));
    expect(grant?.lastUsedAt).toBeGreaterThan(0);
  });

  test("an expired access token is refused", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const expiredToken = token("expired");
    await seedConnectedClient(t, {
      workspaceId: aliceWs,
      userId: alice,
      clientId: CLIENT_A,
      accessToken: expiredToken,
      refreshToken: "crt_expired_000000000000000000000",
      expiresAt: Date.now() - 1,
    });

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/session", { accessToken: expiredToken }),
      ),
    ).toEqual({ session: null });
  });

  test("a grant with no access-token expiry is treated as expired, not as eternal", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const legacyToken = token("legacy");
    await t.run(async (ctx) =>
      ctx.db.insert("oauthGrants", {
        workspaceId: aliceWs,
        userId: alice,
        clientId: CLIENT_A,
        scopes: ["context:read"],
        hashedRefreshToken: await hashToken("crt_legacy_00000000000000000000"),
        hashedAccessToken: await hashToken(legacyToken),
        status: "active",
        createdAt: Date.now(),
      }),
    );

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/session", { accessToken: legacyToken }),
      ),
    ).toEqual({ session: null });
  });

  test("a revoked grant is refused immediately", async () => {
    const { t, grantA } = await twoConnectedTenants();
    await t.run((ctx) =>
      ctx.db.patch(grantA, { status: "revoked", revokedAt: Date.now() }),
    );
    expect(
      await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A })),
    ).toEqual({ session: null });
  });

  test("a grant whose membership row was deleted is refused immediately", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    // While a member, it resolves.
    expect(
      (await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A })))
        .session,
    ).not.toBeNull();

    await removeMembership(t, aliceWs, alice);

    // Removed: gone, with no waiting for a token to expire.
    expect(
      await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A })),
    ).toEqual({ session: null });
  });

  test("a grant whose client was deleted is refused", async () => {
    const { t } = await twoConnectedTenants();
    await t.run(async (ctx) => {
      const client = await ctx.db
        .query("oauthClients")
        .withIndex("by_clientId", (q) => q.eq("clientId", CLIENT_A))
        .unique();
      if (client !== null) await ctx.db.delete(client._id);
    });
    expect(
      await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A })),
    ).toEqual({ session: null });
  });

  test("every refusal is byte-identical", async () => {
    const { t, alice, aliceWs, grantA, grantB } = await twoConnectedTenants();

    const expiredToken = token("expired");
    await seedConnectedClient(t, {
      workspaceId: aliceWs,
      userId: alice,
      clientId: CLIENT_A,
      accessToken: expiredToken,
      refreshToken: "crt_expired2_00000000000000000000",
      expiresAt: Date.now() - 1,
    });
    await t.run((ctx) => ctx.db.patch(grantB, { status: "revoked" }));

    const fingerprints = await Promise.all(
      [
        { accessToken: "totally-unknown-token" },
        { accessToken: expiredToken },
        { accessToken: ACCESS_B },
        // A stored hash, replayed as if it were the token.
        { accessToken: await hashToken(ACCESS_A) },
        // Not a string at all.
        { accessToken: 42 },
        {},
      ].map(async (body) =>
        responseFingerprint(await gatewayPost(t, "/gateway/session", body)),
      ),
    );

    for (const fingerprint of fingerprints) {
      expect(fingerprint).toBe(fingerprints[0]);
    }
    // Non-vacuity: the live token must NOT produce the same answer, or the
    // assertion above is satisfied by everything failing.
    const live = await responseFingerprint(
      await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }),
    );
    expect(live).not.toBe(fingerprints[0]);
    expect(live).toContain(grantA);
  });
});

