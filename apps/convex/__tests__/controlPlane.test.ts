/**
 * THE GATEWAY'S DOOR.
 *
 * `apps/mcp/src/controlPlane.js` documents nine routes and
 * `apps/mcp/test/controlPlaneStub.mjs` implements them in memory. The gateway's
 * own suite runs against that stub, so the stub is the thing our routes must be
 * indistinguishable from — if these and it disagree, the product is broken in
 * production and green in both test suites.
 *
 * What is proved here, in the order it matters:
 *
 *  1. **Two proofs, not one.** The gateway secret alone opens nothing. A user's
 *     access token alone cannot reach the control plane. Only both together
 *     resolve anything, and even then the workspace comes from the *grant*, not
 *     from the caller.
 *  2. **Every negative is byte-identical.** Mismatch, unknown token, expired
 *     token, revoked grant, removed member, unbound storage, unverified
 *     storage, and a workspace that never existed all produce the same status,
 *     the same headers, and the same bytes — in the style of
 *     `isolation.test.ts`, because "both were null" is not the property that
 *     stops an oracle.
 *  3. **A database dump is inert.** The value stored for a token is a digest of
 *     it, so replaying the stored hash as the token matches nothing.
 *  4. **A code is spent once, atomically**, even under two concurrent
 *     redemptions.
 *  5. **A reused refresh token kills the grant**, rather than merely failing.
 *  6. **The gateway secret never escapes** into a response or an audit row.
 *
 * Every credential and token in this file is obviously fake. This repository is
 * public.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import {
  FAKE_D1,
  FAKE_STORAGE,
  TEST_GATEWAY_SECRET,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  gatewayPost,
  responseFingerprint,
  seedAppSecret,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A token long enough to be a real one, and obviously not one. */
function token(label: string): string {
  return `cat_${label}_${"0".repeat(Math.max(0, 34 - label.length))}`;
}

const ACCESS_A = token("tenant_a_owner");
const REFRESH_A = `crt_tenant_a_${"0".repeat(24)}`;
const ACCESS_B = token("tenant_b_owner");
const REFRESH_B = `crt_tenant_b_${"0".repeat(24)}`;
const ACCESS_A_SIBLING = token("tenant_a_sibling");

const CLIENT_A = "mcp_client_alpha";
const CLIENT_A_SIBLING = "mcp_client_alpha_sibling";
const CLIENT_B = "mcp_client_beta";

const REDIRECT_URI = "https://client.example/callback";

/** Register a client through the real route, exactly as the gateway would. */
async function registerClient(
  t: TestConvex,
  clientId: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return await gatewayPost(t, "/gateway/clients/register", {
    clientId,
    clientName: `Client ${clientId}`,
    redirectUris: [REDIRECT_URI],
    hashedClientSecret: null,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scope: "context:read context:write",
    applicationType: "web",
    ...overrides,
  });
}

/**
 * Seed a live grant.
 *
 * Inserted directly rather than driven through the OAuth flow, because most of
 * these tests are about what happens to a grant *after* it exists. The flow
 * itself gets its own section, and the grant it produces is exercised through
 * the same routes.
 */
async function seedConnectedClient(
  t: TestConvex,
  options: {
    workspaceId: Id<"workspaces">;
    userId: Id<"users">;
    clientId: string;
    accessToken: string;
    refreshToken?: string;
    scopes?: string[];
    expiresAt?: number;
  },
): Promise<Id<"oauthGrants">> {
  const hashedAccessToken = await hashToken(options.accessToken);
  const hashedRefreshToken = await hashToken(
    options.refreshToken ?? `${options.accessToken}-refresh`,
  );
  return await t.run((ctx) =>
    ctx.db.insert("oauthGrants", {
      workspaceId: options.workspaceId,
      userId: options.userId,
      clientId: options.clientId,
      scopes: options.scopes ?? ["context:read", "context:write"],
      hashedRefreshToken,
      hashedAccessToken,
      accessTokenExpiresAt: options.expiresAt ?? Date.now() + 3_600_000,
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

/**
 * Two customers, both fully connected: same provider, same endpoint, adjacent
 * bucket names. Tenants on different providers would pass an isolation suite
 * that a one-character bug defeats.
 */
async function twoConnectedTenants() {
  const t = setupTest();
  const alice = await createUser(t, "alice@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");

  const aliceWs = await createWorkspace(t, alice, "alpha", {
    displayName: "Alice's Context",
  });
  const bobWs = await createWorkspace(t, bob, "alphabet", {
    displayName: "Bob's Context",
  });

  await seedStorageBinding(t, {
    workspaceId: aliceWs,
    boundBy: alice,
    bucket: "tenant-a",
  });
  await seedStorageBinding(t, {
    workspaceId: bobWs,
    boundBy: bob,
    bucket: "tenant-ab",
    accessKeyId: "EXAMPLEACCESSKEYID11",
    secretAccessKey: "example-secret-access-key-not-real-111111",
  });

  for (const clientId of [CLIENT_A, CLIENT_A_SIBLING, CLIENT_B]) {
    await registerClient(t, clientId);
  }

  const grantA = await seedConnectedClient(t, {
    workspaceId: aliceWs,
    userId: alice,
    clientId: CLIENT_A,
    accessToken: ACCESS_A,
    refreshToken: REFRESH_A,
  });
  const grantASibling = await seedConnectedClient(t, {
    workspaceId: aliceWs,
    userId: alice,
    clientId: CLIENT_A_SIBLING,
    accessToken: ACCESS_A_SIBLING,
  });
  const grantB = await seedConnectedClient(t, {
    workspaceId: bobWs,
    userId: bob,
    clientId: CLIENT_B,
    accessToken: ACCESS_B,
    refreshToken: REFRESH_B,
  });

  return { t, alice, bob, aliceWs, bobWs, grantA, grantASibling, grantB };
}

/** A syntactically valid workspace id that refers to nothing. */
async function danglingWorkspaceId(t: TestConvex): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { createdAt: Date.now() });
    const id = await ctx.db.insert("workspaces", {
      slug: "temporary-placeholder",
      displayName: "Temporary",
      createdBy: userId,
      kind: "personal",
      structureTemplate: "para",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.delete(id);
    return id;
  });
}

/** Remove someone's membership row, as an owner removing them would. */
async function removeMembership(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<void> {
  await t.run(async (ctx) => {
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", workspaceId).eq("userId", userId),
      )
      .unique();
    if (membership !== null) await ctx.db.delete(membership._id);
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text());
}

/* -------------------------------------------------------------------------- */
/* 1. The gateway secret                                                      */
/* -------------------------------------------------------------------------- */

describe("the gateway secret is necessary", () => {
  test("a request with no Authorization header is refused, on every route", async () => {
    const { t } = await twoConnectedTenants();
    for (const path of [
      "/gateway/session",
      "/gateway/binding",
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
    expect(text).not.toContain("alpha");
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
      { workspaceId: aliceWs, slug: "alpha", role: "owner" },
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
   * connected once can address a brain shared with its owner. What travels with
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
      workspaces: { workspaceId: string; slug: string; role: string }[];
    };

    // No re-approval, no new grant: the membership row is the whole of it.
    expect(session.workspaces).toEqual([
      { workspaceId: aliceWs, slug: "alpha", role: "owner" },
      { workspaceId: bobWs, slug: "alphabet", role: "member" },
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

/* -------------------------------------------------------------------------- */
/* 3. /gateway/binding — the two-factor route                                 */
/* -------------------------------------------------------------------------- */

describe("/gateway/binding", () => {
  test("returns the grant's own workspace's binding, with the secret opened", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );
    expect(body.binding).toEqual({
      workspaceId: aliceWs,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: "tenant-a",
      accessKeyId: FAKE_STORAGE.accessKeyId,
      secretAccessKey: FAKE_STORAGE.secretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "active",
    });
  });

  test("with no workspace named, the grant decides which one comes back", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: null,
      }),
    );
    const binding = body.binding as Record<string, unknown>;
    expect(binding.workspaceId).toBe(aliceWs);
    expect(binding.bucket).toBe("tenant-a");
  });

  test("a rootPrefix is carried through when the customer set one", async () => {
    const t = setupTest();
    const user = await createUser(t, "prefix@example.invalid");
    const workspaceId = await createWorkspace(t, user, "prefixed");
    await seedStorageBinding(t, {
      workspaceId,
      boundBy: user,
      rootPrefix: "context/",
    });
    await registerClient(t, CLIENT_A);
    const accessToken = token("prefixed_owner");
    await seedConnectedClient(t, {
      workspaceId,
      userId: user,
      clientId: CLIENT_A,
      accessToken,
    });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken,
        expectedWorkspaceId: null,
      }),
    );
    expect((body.binding as { rootPrefix: string }).rootPrefix).toBe("context/");
  });

  /**
   * A context the caller was invited into opens; one they were not does not.
   *
   * These two are one test in two halves and must stay together. A grant covers
   * every context its person is a live member of, so the id the gateway names
   * *selects* now instead of only vetoing — and a selection that stopped being
   * bounded by membership is the catastrophe `openStorageBinding`'s own header
   * describes: a compromised gateway holding one valid token walking the
   * customer list one id at a time. The negative half is what says the bound is
   * still there.
   */
  test("a workspace the caller is a member of opens when the gateway names it", async () => {
    const { t, alice, bobWs } = await twoConnectedTenants();
    await addMember(t, bobWs, alice, "member");

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    const binding = body.binding as Record<string, unknown>;
    // The context that was asked for, and its own bucket — not the default's.
    // Answering with the grant's own id here makes the gateway refuse every
    // cross-context call as a disagreement about which tenant it is.
    expect(binding.workspaceId).toBe(bobWs);
    expect(binding.bucket).toBe("tenant-ab");
  });

  test("and stops opening the moment that membership is gone", async () => {
    const { t, alice, bobWs } = await twoConnectedTenants();
    await addMember(t, bobWs, alice, "member");
    const membership = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", bobWs).eq("userId", alice),
        )
        .unique(),
    );
    await t.run((ctx) => ctx.db.delete(membership!._id));

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    // Not "on the next token refresh": the set is re-read on every request, so
    // removing somebody cuts off the clients they already had.
    expect(body).toEqual({ binding: null });
  });

  test("naming another tenant's workspace returns nothing, never that tenant's binding", async () => {
    const { t, bobWs } = await twoConnectedTenants();
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    expect(body).toEqual({ binding: null });
  });

  test("a real-but-forbidden workspace is byte-identical to one that never existed", async () => {
    const { t, bobWs } = await twoConnectedTenants();
    const dangling = await danglingWorkspaceId(t);

    const forbidden = await responseFingerprint(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    const nonexistent = await responseFingerprint(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: dangling,
      }),
    );
    const nonsense = await responseFingerprint(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: "not-even-an-id",
      }),
    );

    expect(forbidden).toBe(nonexistent);
    expect(forbidden).toBe(nonsense);
  });

  /**
   * The list from the contract, all at once. Distinguishing any pair of these
   * turns the route into an oracle for whoever holds the gateway secret and one
   * valid token.
   */
  test("mismatch, unknown, expired, revoked, unbound and unverified are one answer", async () => {
    const { t, alice, aliceWs, bobWs, bob, grantB } = await twoConnectedTenants();

    // A third tenant, bound but never verified.
    const carol = await createUser(t, "carol@example.invalid");
    const carolWs = await createWorkspace(t, carol, "carol-context");
    await seedStorageBinding(t, {
      workspaceId: carolWs,
      boundBy: carol,
      bucket: "tenant-c",
      status: "unverified",
    });
    const carolToken = token("tenant_c_owner");
    await seedConnectedClient(t, {
      workspaceId: carolWs,
      userId: carol,
      clientId: CLIENT_A,
      accessToken: carolToken,
      refreshToken: "crt_tenant_c_000000000000000000",
    });

    // A fourth, with no storage at all.
    const dave = await createUser(t, "dave@example.invalid");
    const daveWs = await createWorkspace(t, dave, "dave-context");
    const daveToken = token("tenant_d_owner");
    await seedConnectedClient(t, {
      workspaceId: daveWs,
      userId: dave,
      clientId: CLIENT_A,
      accessToken: daveToken,
      refreshToken: "crt_tenant_d_000000000000000000",
    });

    const expiredToken = token("expired3");
    await seedConnectedClient(t, {
      workspaceId: aliceWs,
      userId: alice,
      clientId: CLIENT_A,
      accessToken: expiredToken,
      refreshToken: "crt_expired3_00000000000000000000",
      expiresAt: Date.now() - 1,
    });
    await t.run((ctx) => ctx.db.patch(grantB, { status: "revoked" }));

    const dangling = await danglingWorkspaceId(t);
    const cases: { accessToken: unknown; expectedWorkspaceId: unknown }[] = [
      { accessToken: ACCESS_A, expectedWorkspaceId: bobWs }, // mismatch
      { accessToken: ACCESS_A, expectedWorkspaceId: dangling }, // nonexistent
      { accessToken: "unknown-token", expectedWorkspaceId: null }, // unknown
      { accessToken: expiredToken, expectedWorkspaceId: null }, // expired
      { accessToken: ACCESS_B, expectedWorkspaceId: null }, // revoked
      { accessToken: carolToken, expectedWorkspaceId: null }, // unverified storage
      { accessToken: daveToken, expectedWorkspaceId: null }, // never bound
      { accessToken: await hashToken(ACCESS_A), expectedWorkspaceId: null }, // stored hash
    ];

    const fingerprints = await Promise.all(
      cases.map(async (body) =>
        responseFingerprint(await gatewayPost(t, "/gateway/binding", body)),
      ),
    );
    for (const [index, fingerprint] of fingerprints.entries()) {
      expect(fingerprint, `case ${index} answered differently`).toBe(fingerprints[0]);
    }
    expect(JSON.parse(fingerprints[0].split("\n").pop() ?? "{}")).toEqual({
      binding: null,
    });

    // Non-vacuity: bob's own live token still gets bob's own binding, so the
    // sameness above is not "everything is broken".
    await t.run((ctx) => ctx.db.patch(grantB, { status: "active" }));
    const bobsOwn = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_B,
        expectedWorkspaceId: null,
      }),
    );
    expect((bobsOwn.binding as { bucket: string }).bucket).toBe("tenant-ab");
    expect(bob).toBeDefined();
  });

  test("a removed member's client cannot fetch a credential either", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await removeMembership(t, aliceWs, alice);
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/binding", {
          accessToken: ACCESS_A,
          expectedWorkspaceId: null,
        }),
      ),
    ).toEqual({ binding: null });
  });

  test("no call shape returns more than one workspace's binding", async () => {
    const { t, bobWs } = await twoConnectedTenants();
    // Every way of asking that could plausibly be read as "give me a list", or
    // as "give me that other one".
    for (const body of [
      { accessToken: ACCESS_A, expectedWorkspaceId: null },
      { accessToken: ACCESS_A, expectedWorkspaceId: bobWs },
      { accessToken: ACCESS_A },
      { accessToken: ACCESS_A, expectedWorkspaceId: [bobWs] },
      { accessToken: [ACCESS_A, ACCESS_B], expectedWorkspaceId: null },
    ] as unknown[]) {
      const parsed = await bodyOf(await gatewayPost(t, "/gateway/binding", body));
      expect(Array.isArray(parsed.binding)).toBe(false);
      const text = JSON.stringify(parsed);
      // Never the other tenant's bucket or key, under any shape.
      expect(text).not.toContain("tenant-ab");
      expect(text).not.toContain("EXAMPLEACCESSKEYID11");
      expect(text).not.toContain("111111");
    }
  });

  test("a credential is fetched afresh; the row is the only place it lives", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const first = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );
    // Disconnect underneath, and the very next call has nothing to serve. No
    // memo, no cache, no module-level state carrying one tenant's credential
    // into the next request.
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .unique();
      if (binding !== null) await ctx.db.delete(binding._id);
    });
    const second = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );

    expect((first.binding as { bucket: string }).bucket).toBe("tenant-a");
    expect(second).toEqual({ binding: null });
  });
});

/* -------------------------------------------------------------------------- */
/* 3b. /gateway/binding — the search-index credential beside it               */
/* -------------------------------------------------------------------------- */

/**
 * THE SECOND CREDENTIAL ON THE TWO-FACTOR ROUTE.
 *
 * Fast search provisions a D1 database per opted-in context and nothing was
 * copying notes into it — three databases in production, schema applied, zero
 * rows. The gateway is the only component in this system that reads note text,
 * so the projection has to be its job, and it needs two things it cannot get
 * anywhere else: a database to write into and a token that may write into it.
 *
 * They ride on `/gateway/binding` rather than a route of their own, and that is
 * the security decision rather than a convenience. A second route handing out a
 * credential is a third entry in `structure.test.ts`'s `CREDENTIAL_HTTP_ROUTES`
 * — whose comment says a second entry "means a second internet-facing path to
 * other people's bucket keys" and that a third needs the argument made again.
 * Here the argument does not have to be made: the same two proofs are spent,
 * the workspace is resolved once from the same grant, and there is no new door.
 *
 * So what these tests are about is that the *same* bound holds for the *new*
 * payload. In particular that a caller cannot name whose index it gets, which
 * is the property the whole route exists to have.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts as measured.
 *
 *   the index lookup hoisted above the membership check, keyed on
 *     `args.expectedWorkspaceId`                                        5
 *   the index lookup left in place, keyed on `args.expectedWorkspaceId` 1
 *   the `apiToken`/`accountId` both-or-neither check dropped            1
 *   `searchProjectionState` accepting `failed` and `provisioning`       2
 *
 * The two-factor property here is **inherited rather than restated**, and the
 * two forms of the first sabotage are what measure the difference. Keying the
 * index query on the caller's own `expectedWorkspaceId` where it sits changes
 * no behaviour at all: `covered === undefined` has already returned `null` for
 * every id the token does not cover, so by the time the index is read the only
 * value that argument can hold is the one the grant resolved to. Exactly one
 * test reddens — `structure.test.ts`'s textual rule that the argument may never
 * select — which is that rule earning its place: it fails on the *shape* before
 * the shape becomes exploitable.
 *
 * Move the same lookup above the membership check and it becomes the real
 * thing: a compromised gateway holding one valid token reads any opted-in
 * context's database id and the account-wide write token, one id at a time.
 * Five tests redden, three of them in this block, and that is why the
 * cross-tenant test below asserts on the **bytes of the whole response** rather
 * than on `body.searchIndex` — under that mutant the binding half is still a
 * correct `null`, and everything that leaks leaks beside it.
 *
 * `searchProjectionState`'s own guards are unit-tested in `fastSearch.test.ts`,
 * which records why two of them measured zero from here.
 */
describe("/gateway/binding — the search index", () => {
  /**
   * An opted-in, provisioned index row, inserted directly.
   *
   * `fastSearch.enable` would schedule a real provision, which in a test
   * reaches for a Cloudflare token that is not there and flips the row to
   * `failed` partway through whatever the test was about — the same fixture
   * race `seedStorageBinding` exists to avoid.
   */
  async function seedSearchIndex(
    t: TestConvex,
    options: {
      workspaceId: Id<"workspaces">;
      optedInBy: Id<"users">;
      status?: "provisioning" | "backfilling" | "ready" | "failed" | "releasing";
      optedIn?: boolean;
      databaseId?: string;
    },
  ): Promise<void> {
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("searchIndexes", {
        workspaceId: options.workspaceId,
        optedIn: options.optedIn ?? true,
        optedInBy: options.optedInBy,
        optedInAt: now,
        status: options.status ?? "ready",
        databaseId: options.databaseId,
        databaseName:
          options.databaseId === undefined ? undefined : `context-search-${options.databaseId}`,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  /** The deployment configured with both halves of the platform's credential. */
  async function configureD1(t: TestConvex): Promise<void> {
    await seedAppSecret(t, "SEARCH_D1_API_TOKEN", FAKE_D1.apiToken);
    await seedAppSecret(t, "SEARCH_D1_ACCOUNT_ID", FAKE_D1.accountId);
  }

  test("an opted-in, provisioned context gets a write credential beside its binding", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      status: "backfilling",
      databaseId: "db-alice-0000",
    });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );
    // The binding is untouched by any of this — the fast path is an upgrade,
    // and a context whose index broke must still be able to read its bucket.
    expect((body.binding as { bucket: string }).bucket).toBe("tenant-a");
    expect(body.searchIndex).toEqual({
      databaseId: "db-alice-0000",
      accountId: FAKE_D1.accountId,
      apiToken: FAKE_D1.apiToken,
      state: "backfilling",
    });
  });

  test("a ready index reports ready, so the gateway knows it is not backfilling", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      status: "ready",
      databaseId: "db-alice-ready",
    });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: null,
      }),
    );
    expect((body.searchIndex as { state: string }).state).toBe("ready");
  });

  /**
   * THE NORMAL CASE, AND IT MUST NOT BE AN ERROR.
   *
   * Almost every context has never opted in. The key is absent — not present
   * and null — so a gateway on a build that predates this reads the same bytes
   * it always did.
   */
  test("a context that never opted in has no searchIndex key at all", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await configureD1(t);

    const response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("searchIndex");
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["binding"]);
    expect((body.binding as { bucket: string }).bucket).toBe("tenant-a");
  });

  /**
   * OFF DELETES IT, SO OFF MUST STOP HANDING OUT THE KEY TO IT.
   *
   * `disable` sets `optedIn: false` and leaves the row `releasing` until
   * Cloudflare confirms the delete — deliberately, so the database can still be
   * found. A projection credential served during that window would keep writing
   * a copy of somebody's notes into a database they asked us to destroy, which
   * is the switch not working.
   */
  test("a releasing context is handed nothing, even though the row still names a database", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      optedIn: false,
      status: "releasing",
      databaseId: "db-being-deleted",
    });

    const response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    const text = await response.text();
    expect(text).not.toContain("searchIndex");
    expect(text).not.toContain("db-being-deleted");
    expect(text).not.toContain(FAKE_D1.apiToken);
  });

  test("a half-built index is handed nothing either", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await configureD1(t);

    // Provisioning: the database may exist but the schema is not on it yet.
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      status: "provisioning",
      databaseId: "db-no-schema-yet",
    });
    let text = await (
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: null,
      })
    ).text();
    expect(text).not.toContain("searchIndex");
    expect(text).not.toContain("db-no-schema-yet");

    // Failed, with a database recorded: a projection into a half-built database
    // is how a failure becomes data.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .unique();
      await ctx.db.patch(row!._id, { status: "failed" });
    });
    text = await (
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: null,
      })
    ).text();
    expect(text).not.toContain("searchIndex");

    // Opted in and provisioned with no database id recorded — nothing to write
    // into, and naming no database is not the same as naming none of them.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .unique();
      await ctx.db.patch(row!._id, { status: "ready", databaseId: undefined });
    });
    text = await (
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: null,
      })
    ).text();
    expect(text).not.toContain("searchIndex");
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * Both tenants have an index. Alice names bob's workspace, exactly as a
   * compromised gateway holding one valid token would. She is not a member of
   * it, so the binding half already answers `null` — and the assertion is on the
   * **bytes of the whole response**, not on `body.searchIndex`, because the
   * mutant this exists to catch (the index query keyed on the caller's own
   * `expectedWorkspaceId` rather than on the id the grant resolved to) leaves
   * the binding half correct and rides bob's database id and the account-wide
   * write token out beside it.
   */
  test("a caller cannot obtain another tenant's index credential by naming it", async () => {
    const { t, alice, aliceWs, bob, bobWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      databaseId: "db-alice-0000",
    });
    await seedSearchIndex(t, {
      workspaceId: bobWs,
      optedInBy: bob,
      databaseId: "db-bob-1111",
    });

    const response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: bobWs,
    });
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ binding: null });
    expect(text).not.toContain("db-bob-1111");
    expect(text).not.toContain(FAKE_D1.apiToken);
    expect(text).not.toContain(FAKE_D1.accountId);

    // Non-vacuity: alice's own call gets alice's own database, so the refusal
    // above is not "the feature is off".
    const own = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );
    expect((own.searchIndex as { databaseId: string }).databaseId).toBe("db-alice-0000");
  });

  /**
   * The other half of that pair, kept beside it for the reason the binding
   * tests keep theirs together: a context alice really is a member of opens.
   *
   * The credential belongs to the *context*, not to the caller's role in it —
   * the same as the bucket key beside it. A member searching bob's brain is
   * answered from bob's database, filtered by `canSee` at read time, so the
   * gateway needs the projection for whichever context the call addressed.
   */
  test("a context the caller is a member of opens, index and all", async () => {
    const { t, alice, bob, bobWs } = await twoConnectedTenants();
    await configureD1(t);
    await addMember(t, bobWs, alice, "member");
    await seedSearchIndex(t, {
      workspaceId: bobWs,
      optedInBy: bob,
      databaseId: "db-bob-1111",
    });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    expect((body.binding as { workspaceId: string }).workspaceId).toBe(bobWs);
    expect((body.searchIndex as { databaseId: string }).databaseId).toBe("db-bob-1111");

    // And the moment that membership goes, so does the reach — the set is
    // re-read on every request.
    const membership = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", bobWs).eq("userId", alice),
        )
        .unique(),
    );
    await t.run((ctx) => ctx.db.delete(membership!._id));
    const after = await (
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      })
    ).text();
    expect(JSON.parse(after)).toEqual({ binding: null });
    expect(after).not.toContain("db-bob-1111");
  });

  /**
   * A deployment nobody has configured is an ordinary state, not a crash — the
   * same rule `fastSearchProvision` states for the provisioner. A self-hoster
   * who never pasted a D1 token gets a working binding and no fast search.
   *
   * Half-configured reads exactly like unconfigured, because there is one cure.
   */
  test("an unconfigured deployment serves the binding and no index", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      databaseId: "db-alice-0000",
    });

    // Neither half set.
    let response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    let text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("searchIndex");
    expect((JSON.parse(text).binding as { bucket: string }).bucket).toBe("tenant-a");

    // The token but not the account id.
    await seedAppSecret(t, "SEARCH_D1_API_TOKEN", FAKE_D1.apiToken);
    response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("searchIndex");
    expect(text).not.toContain(FAKE_D1.apiToken);
  });

  /**
   * THE TOKEN IS IN NO REFUSAL, ON ANY SHAPE OF THE REQUEST.
   *
   * A credential that reaches an error body reaches a log, a bug report and a
   * screenshot. Every negative this route can produce is checked against the
   * configured token in one sweep, including the refusals that happen before
   * the two proofs are even read.
   */
  test("the write token never appears in a refusal", async () => {
    const { t, alice, aliceWs, bobWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      databaseId: "db-alice-0000",
    });

    const attempts: { body: unknown; secret?: string | null }[] = [
      { body: { accessToken: ACCESS_A, expectedWorkspaceId: bobWs } },
      { body: { accessToken: "unknown-token", expectedWorkspaceId: null } },
      { body: { accessToken: ACCESS_A, expectedWorkspaceId: "not-even-an-id" } },
      { body: { accessToken: ACCESS_A, expectedWorkspaceId: [bobWs] } },
      { body: {} },
      { body: "not-an-object" },
      { body: { accessToken: ACCESS_A }, secret: "wrong-secret" },
      { body: { accessToken: ACCESS_A }, secret: null },
    ];

    for (const [index, attempt] of attempts.entries()) {
      const text = await (
        await gatewayPost(t, "/gateway/binding", attempt.body, {
          secret: attempt.secret,
        })
      ).text();
      expect(text, `attempt ${index} leaked the token`).not.toContain(
        FAKE_D1.apiToken,
      );
      expect(text, `attempt ${index} leaked the account id`).not.toContain(
        FAKE_D1.accountId,
      );
      expect(text, `attempt ${index} leaked a database id`).not.toContain(
        "db-alice-0000",
      );
    }

    // Non-vacuity: the happy path really does carry all three, so the sweep
    // above is not passing because nothing is ever returned.
    const ok = await (
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      })
    ).text();
    expect(ok).toContain(FAKE_D1.apiToken);
    expect(ok).toContain("db-alice-0000");
  });
});

/* -------------------------------------------------------------------------- */
/* 3c. /gateway/search-index/progress — the backfill reporting back          */
/* -------------------------------------------------------------------------- */

/**
 * THE ROUTE WITH ONE PROOF, AND WHY IT IS SAFE TO HAVE ONE.
 *
 * A backfill runs behind a response and outlives the request that started it,
 * so there is no user access token to present — the same reason the ingest
 * routes cannot present one. What a holder of the gateway secret can therefore
 * do here, for a workspace it names, is the whole of the residual risk: write
 * two integers onto a row, and move one that is already backfilling to `ready`.
 *
 * It cannot read anything. It cannot learn whether the id it named exists,
 * whether that context opted in, or whether the report was applied — **every
 * input is answered with the same bytes**, which is the property the first test
 * here is about and the reason `/gateway/usage` is shaped the same way.
 *
 * Everything else is the control plane owning its own row. The gateway knows
 * how many notes it wrote; it does not know whether the owner turned the
 * feature off while it was writing them, and a report that could re-open a row
 * somebody turned off would make the switch not work.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts as measured.
 *
 *   `recordProjectionProgress` dropping the `searchProjectionState` gate    2
 *   `status` assigned `"ready"` unconditionally                             1
 *   a report without `state` demoting a `ready` row to `backfilling`        1
 *   the route answering `{ applied }` instead of one constant answer        1
 *   `countField` coercing rather than refusing a bad count                  2
 *
 * The gate row is **2, not 3**, and the missing one is worth naming. The mutant
 * run was `if (binding === null) return` in place of the composed gate, and a
 * context that never opted in has no row at all — so any implementation that
 * reads a row before writing to it refuses that case, and "a report for a
 * context that never opted in is refused" cannot separate them. It is still
 * written, because what it pins is the *product* property (no row means never
 * asked, so the count of customers we hold a copy for stays a count rather than
 * a filter) rather than that one line of the gate.
 *
 * The other two — opted out mid-release, and half-built — do separate, and they
 * are two tests rather than one because the states arrive by different routes
 * through the product and a future change could reopen either alone.
 *
 * `recordProjectionProgress` also re-validates the counts the route already
 * validated, and that guard measured **zero** from here for the reason
 * `fastSearch.test.ts` records: the door is one caller, and only a direct call
 * to the mutation can tell the two layers apart. The test that does is there.
 */
describe("/gateway/search-index/progress", () => {
  async function enabledIndex(t: TestConvex, workspaceId: Id<"workspaces">, owner: Id<"users">) {
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("searchIndexes", {
        workspaceId,
        optedIn: true,
        optedInBy: owner,
        optedInAt: now,
        status: "backfilling",
        databaseId: "db-progress",
        databaseName: "context-search-progress",
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  async function indexRow(t: TestConvex, workspaceId: Id<"workspaces">) {
    return await t.run((ctx) =>
      ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
  }

  async function report(
    t: TestConvex,
    body: unknown,
    options: { secret?: string | null } = {},
  ): Promise<Response> {
    return await gatewayPost(t, "/gateway/search-index/progress", body, options);
  }

  test("a report from the gateway moves the counters an owner reads", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);

    const response = await report(t, {
      workspaceId: aliceWs,
      notesIndexed: 41,
      notesPending: 7,
    });
    expect(response.status).toBe(200);

    const row = await indexRow(t, aliceWs);
    expect(row?.notesIndexed).toBe(41);
    expect(row?.notesPending).toBe(7);
    // Still backfilling: reporting progress is not declaring victory.
    expect(row?.status).toBe("backfilling");

    // And the owner's screen sees it, percentage and all.
    const status = await asUser(t, alice).query(api.functions.fastSearch.status, {
      workspaceId: aliceWs,
    });
    expect(status.notesIndexed).toBe(41);
    expect(status.notesPending).toBe(7);
    expect(status.percentIndexed).toBe(85);
    expect(status.state).toBe("preparing");
  });

  test("the gateway saying ready is what finishes the backfill", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);

    await report(t, {
      workspaceId: aliceWs,
      notesIndexed: 48,
      notesPending: 0,
      state: "ready",
    });
    expect((await indexRow(t, aliceWs))?.status).toBe("ready");
    const status = await asUser(t, alice).query(api.functions.fastSearch.status, {
      workspaceId: aliceWs,
    });
    expect(status.state).toBe("on");
    expect(status.percentIndexed).toBe(100);

    // A later report without `ready` must not restart the spinner: a gateway
    // that keeps projecting new notes after finishing is the ordinary case.
    await report(t, { workspaceId: aliceWs, notesIndexed: 50, notesPending: 2 });
    const row = await indexRow(t, aliceWs);
    expect(row?.status).toBe("ready");
    expect(row?.notesPending).toBe(2);
  });

  /**
   * A CONTEXT THAT IS NOT OPTED IN IS NOT A ROW TO WRITE TO.
   *
   * Three shapes, one gate, three tests — because they arrive by three routes
   * through the product and a change could reopen any of them alone.
   */
  test("a report for a context that never opted in is refused", async () => {
    const { t, aliceWs } = await twoConnectedTenants();

    const response = await report(t, {
      workspaceId: aliceWs,
      notesIndexed: 41,
      notesPending: 7,
    });
    expect(response.status).toBe(200);
    // No row was created. "No row means never asked" is how the count of
    // customers we hold a copy for stays a count rather than a filter.
    expect(await indexRow(t, aliceWs)).toBeNull();
    expect(
      await t.run(async (ctx) => (await ctx.db.query("searchIndexes").collect()).length),
    ).toBe(0);
  });

  test("a report cannot re-open a row somebody turned off", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);
    // The owner turns it off. The row survives as `releasing` so the delete can
    // still find its database.
    await asUser(t, alice).mutation(api.functions.fastSearch.disable, {
      workspaceId: aliceWs,
    });
    expect((await indexRow(t, aliceWs))?.status).toBe("releasing");

    // The backfill, which has been running all along, reports in and says it
    // finished. This is the late arrival that must change nothing.
    await report(t, {
      workspaceId: aliceWs,
      notesIndexed: 999,
      notesPending: 0,
      state: "ready",
    });

    const row = await indexRow(t, aliceWs);
    // Not `ready`: that would put a database mid-delete back into service.
    expect(row?.status).toBe("releasing");
    expect(row?.optedIn).toBe(false);
    // And not the counters either — a row nobody is serving from should not be
    // accumulating a census of somebody's notes.
    expect(row?.notesIndexed).toBeUndefined();
    expect(row?.notesPending).toBeUndefined();

    // The owner's screen still says off, which is what they pressed.
    const status = await asUser(t, alice).query(api.functions.fastSearch.status, {
      workspaceId: aliceWs,
    });
    expect(status.state).toBe("off");
  });

  test("a half-built index cannot be declared ready by a report", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);

    for (const status of ["provisioning", "failed"] as const) {
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("searchIndexes")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
          .unique();
        await ctx.db.patch(row!._id, { status });
      });

      await report(t, {
        workspaceId: aliceWs,
        notesIndexed: 12,
        notesPending: 0,
        state: "ready",
      });

      const row = await indexRow(t, aliceWs);
      expect(row?.status, `${status} was moved by a progress report`).toBe(status);
      expect(row?.notesIndexed).toBeUndefined();
    }
  });

  /**
   * EVERY INPUT IS ANSWERED IDENTICALLY.
   *
   * A holder of the gateway secret must not be able to use this route to learn
   * which contexts have opted in. An accepted report, a refused one, one for a
   * context that does not exist and one for an id that is not an id are the
   * same status, the same headers and the same bytes — the comparison
   * `isolation.test.ts` insists on, because "both returned 200" is not the
   * property that stops an oracle.
   */
  test("an accepted report and a refused one are byte-identical", async () => {
    const { t, alice, aliceWs, bobWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);
    const dangling = await danglingWorkspaceId(t);

    const fingerprints = await Promise.all(
      [
        // Accepted.
        { workspaceId: aliceWs, notesIndexed: 1, notesPending: 1 },
        // A real context that never opted in.
        { workspaceId: bobWs, notesIndexed: 1, notesPending: 1 },
        // A context that does not exist.
        { workspaceId: dangling, notesIndexed: 1, notesPending: 1 },
        // Not an id at all.
        { workspaceId: "not-even-an-id", notesIndexed: 1, notesPending: 1 },
        // Malformed in every other way.
        { workspaceId: aliceWs, notesIndexed: -1, notesPending: 1 },
        { workspaceId: aliceWs, notesIndexed: 1.5, notesPending: 1 },
        { workspaceId: aliceWs, notesIndexed: "12", notesPending: 1 },
        { workspaceId: aliceWs, notesIndexed: 1 },
        { workspaceId: aliceWs, notesIndexed: 1, notesPending: 1, state: "on" },
        {},
      ].map(async (body) => responseFingerprint(await report(t, body as unknown))),
    );
    for (const [index, fingerprint] of fingerprints.entries()) {
      expect(fingerprint, `case ${index} answered differently`).toBe(fingerprints[0]);
    }

    // Non-vacuity: the accepted one really was applied, so the sameness above is
    // not "nothing works".
    expect((await indexRow(t, aliceWs))?.notesIndexed).toBe(1);
    // ...and none of the refusals wrote anything.
    expect(await indexRow(t, bobWs)).toBeNull();
  });

  /**
   * A COUNT THAT IS NOT A COUNT IS REFUSED, NOT COERCED.
   *
   * These are rendered to an owner as a percentage. A negative makes a progress
   * bar run backwards; a stored `Infinity` makes the row unrenderable for good;
   * a fraction is a note count that is not a number of notes.
   */
  test("a malformed count writes nothing at all", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);
    await report(t, { workspaceId: aliceWs, notesIndexed: 10, notesPending: 5 });

    for (const bad of [
      { notesIndexed: -1, notesPending: 0 },
      { notesIndexed: 0, notesPending: -1 },
      { notesIndexed: 1.5, notesPending: 0 },
      { notesIndexed: Number.MAX_VALUE * 2, notesPending: 0 },
      { notesIndexed: "41", notesPending: 7 },
      { notesIndexed: null, notesPending: 7 },
      { notesIndexed: 41 },
    ]) {
      await report(t, { workspaceId: aliceWs, ...bad } as unknown);
      const row = await indexRow(t, aliceWs);
      expect(row?.notesIndexed, `${JSON.stringify(bad)} was written`).toBe(10);
      expect(row?.notesPending).toBe(5);
    }
  });

  test("the gateway secret is still necessary", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);

    for (const secret of [null, "wrong-secret", `${TEST_GATEWAY_SECRET}x`]) {
      const response = await report(
        t,
        { workspaceId: aliceWs, notesIndexed: 41, notesPending: 7 },
        { secret },
      );
      expect(response.status).toBe(401);
      expect((await indexRow(t, aliceWs))?.notesIndexed).toBeUndefined();
    }
  });

  /**
   * The route carries no credential and must never grow one. `structure.test.ts`
   * enforces the structural half — this is the behavioural one, in the same
   * spirit as the token sweep on `/gateway/binding`.
   */
  test("no answer here carries a credential of any kind", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await seedAppSecret(t, "SEARCH_D1_API_TOKEN", FAKE_D1.apiToken);
    await seedAppSecret(t, "SEARCH_D1_ACCOUNT_ID", FAKE_D1.accountId);
    await enabledIndex(t, aliceWs, alice);

    const text = await (
      await report(t, { workspaceId: aliceWs, notesIndexed: 41, notesPending: 7 })
    ).text();
    expect(text).not.toContain(FAKE_D1.apiToken);
    expect(text).not.toContain(FAKE_D1.accountId);
    expect(text).not.toContain("db-progress");
    expect(text).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(text).not.toContain(TEST_GATEWAY_SECRET);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. A database dump is inert                                                */
/* -------------------------------------------------------------------------- */

describe("a dump of the grants table plus the gateway secret is inert", () => {
  test("the stored value is a digest, not the token", async () => {
    const { t, grantA } = await twoConnectedTenants();
    const grant = await t.run((ctx) => ctx.db.get(grantA));
    expect(grant?.hashedAccessToken).toBe(await hashToken(ACCESS_A));
    expect(grant?.hashedAccessToken).not.toBe(ACCESS_A);
    expect(grant?.hashedRefreshToken).not.toBe(REFRESH_A);
  });

  test("replaying a stored hash as a token opens nothing, on any route", async () => {
    const { t, grantA, aliceWs } = await twoConnectedTenants();
    const grant = await t.run((ctx) => ctx.db.get(grantA));
    const storedAccess = grant!.hashedAccessToken as string;
    const storedRefresh = grant!.hashedRefreshToken;

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/session", { accessToken: storedAccess }),
      ),
    ).toEqual({ session: null });

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/binding", {
          accessToken: storedAccess,
          expectedWorkspaceId: aliceWs,
        }),
      ),
    ).toEqual({ binding: null });

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/grants/rotate", {
          refreshToken: storedRefresh,
          clientId: CLIENT_A,
          newHashedRefreshToken: await hashToken("crt_thief_000000000000000000000"),
          newHashedAccessToken: await hashToken("cat_thief_000000000000000000000"),
          accessTokenExpiresAt: Date.now() + 3_600_000,
          scopes: null,
        }),
      ),
    ).toEqual({ grant: null });

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/grants/revoke", {
          token: storedAccess,
          tokenType: "access",
          clientId: CLIENT_A,
        }),
      ),
    ).toEqual({ revoked: false });

    // …and the real token still works, so the grant was not collaterally killed
    // by the attempts above.
    expect(
      (await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A })))
        .session,
    ).not.toBeNull();
  });

  test("an authorization code is stored as a digest too", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });
    const row = await t.run((ctx) =>
      ctx.db.query("oauthAuthorizations").first(),
    );
    expect(row?.hashedCode).toBe(await hashToken(code));
    expect(row?.hashedCode).not.toBe(code);

    // The stored digest is not spendable.
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/codes/consume", {
          code: row!.hashedCode,
          clientId: CLIENT_A,
        }),
      ),
    ).toEqual({ authorization: null });
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Client registration                                                     */
/* -------------------------------------------------------------------------- */

describe("/gateway/clients/register and /gateway/clients/get", () => {
  test("registers a client and reads it back in the documented shape", async () => {
    const t = setupTest();
    expect((await registerClient(t, "mcp_new")).status).toBe(200);
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/clients/get", { clientId: "mcp_new" }),
    );
    expect(body.client).toEqual({
      clientId: "mcp_new",
      clientName: "Client mcp_new",
      redirectUris: [REDIRECT_URI],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
    });
  });

  test("is idempotent on clientId, so a redeploy does not orphan grants", async () => {
    const t = setupTest();
    await registerClient(t, "mcp_same");
    await registerClient(t, "mcp_same", { clientName: "Renamed" });
    const clients = await t.run((ctx) => ctx.db.query("oauthClients").collect());
    expect(clients).toHaveLength(1);
    expect(clients[0].clientName).toBe("Renamed");
  });

  test("keeps a confidential client's secret as a hash", async () => {
    const t = setupTest();
    const hashed = await hashToken("mcs_obviously_fake_client_secret");
    await registerClient(t, "mcp_confidential", {
      hashedClientSecret: hashed,
      tokenEndpointAuthMethod: "client_secret_post",
    });
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/clients/get", { clientId: "mcp_confidential" }),
    );
    expect(body.client).toMatchObject({
      hashedClientSecret: hashed,
      tokenEndpointAuthMethod: "client_secret_post",
    });
  });

  test("refuses a plaintext client secret where a hash belongs", async () => {
    const t = setupTest();
    const response = await registerClient(t, "mcp_plaintext", {
      hashedClientSecret: "mcs_this_is_the_actual_secret",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(response.status).toBe(400);
    expect(await t.run((ctx) => ctx.db.query("oauthClients").collect())).toEqual([]);
  });

  test("refuses a redirect URI that would carry a code in cleartext", async () => {
    const t = setupTest();
    for (const uri of [
      "http://evil.example/callback",
      "ftp://client.example/callback",
      "myapp://callback",
      "https://client.example/callback#fragment",
      "not a url",
    ]) {
      const response = await registerClient(t, `mcp_bad_${uri.length}`, {
        redirectUris: [uri],
      });
      expect(response.status, `${uri} was accepted`).toBe(400);
    }
    // Loopback http is the native-client case and must still work.
    expect(
      (
        await registerClient(t, "mcp_native", {
          redirectUris: ["http://127.0.0.1/callback"],
          applicationType: "native",
        })
      ).status,
    ).toBe(200);
  });

  test("an unknown client is null, not an error", async () => {
    const t = setupTest();
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/clients/get", { clientId: "never-registered" }),
      ),
    ).toEqual({ client: null });
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The authorization flow                                                  */
/* -------------------------------------------------------------------------- */

/** base64url of the SHA-256 of a verifier — an S256 PKCE challenge. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier) as BufferSource,
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const VERIFIER = "a".repeat(64);
const OTHER_VERIFIER = "b".repeat(64);

async function startAuthorization(
  t: TestConvex,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return await gatewayPost(t, "/gateway/authorize/start", {
    clientId: CLIENT_A,
    redirectUri: REDIRECT_URI,
    state: "xyz",
    codeChallenge: await s256(VERIFIER),
    codeChallengeMethod: "S256",
    scope: "context:read context:write",
    resource: "https://mcp.context.test/mcp",
    requestedWorkspaceSlug: "alpha",
    ...overrides,
  });
}

/** Park a request, approve it while narrowing, and pull the code out. */
async function startAndApproveWith(
  t: TestConvex,
  who: { alice: Id<"users">; aliceWs: Id<"workspaces"> },
  grantedScopes: string[],
  overrides: Record<string, unknown> = {},
): Promise<{ requestId: string; code: string }> {
  const started = await bodyOf(await startAuthorization(t, overrides));
  const requestId = started.requestId as string;
  const { redirectTo } = await asUser(t, who.alice).action(
    api.functions.authorizations.approveAuthorization,
    { requestId, workspaceId: who.aliceWs, grantedScopes },
  );
  const code = new URL(redirectTo).searchParams.get("code");
  if (code === null) throw new Error("no code in the approval redirect");
  return { requestId, code };
}

/** Park a request, sign in as its approver, and pull the code out of the redirect. */
async function startAndApprove(
  t: TestConvex,
  who: { alice: Id<"users">; aliceWs: Id<"workspaces"> },
  overrides: Record<string, unknown> = {},
): Promise<{ requestId: string; code: string; redirectTo: string }> {
  const started = await bodyOf(await startAuthorization(t, overrides));
  const requestId = started.requestId as string;
  const { redirectTo } = await asUser(t, who.alice).action(
    api.functions.authorizations.approveAuthorization,
    { requestId, workspaceId: who.aliceWs },
  );
  const code = new URL(redirectTo).searchParams.get("code");
  if (code === null) throw new Error("no code in the approval redirect");
  return { requestId, code, redirectTo };
}

describe("/gateway/authorize/start", () => {
  test("parks a request and hands back a consent URL on an origin we own", async () => {
    const { t } = await twoConnectedTenants();
    const body = await bodyOf(await startAuthorization(t));
    expect(typeof body.requestId).toBe("string");
    const consent = new URL(body.consentUrl as string);
    expect(consent.protocol).toBe("https:");
    expect(consent.origin).toBe("https://app.context.invalid");
    expect(consent.searchParams.get("request_id")).toBe(body.requestId);
  });

  test("the consent URL carries no token, no secret, and no credential", async () => {
    const { t } = await twoConnectedTenants();
    const body = await bodyOf(await startAuthorization(t));
    const url = body.consentUrl as string;
    expect(url).not.toContain(TEST_GATEWAY_SECRET);
    expect(url).not.toContain(ACCESS_A);
    expect(url).not.toContain(FAKE_STORAGE.secretAccessKey);
  });

  test("refuses PKCE `plain`, and refuses no PKCE at all", async () => {
    const { t } = await twoConnectedTenants();
    expect(
      (
        await startAuthorization(t, {
          codeChallengeMethod: "plain",
          codeChallenge: VERIFIER,
        })
      ).status,
    ).toBe(400);
    expect((await startAuthorization(t, { codeChallenge: "" })).status).toBe(400);
    expect(
      (await startAuthorization(t, { codeChallenge: "too-short" })).status,
    ).toBe(400);
    expect(await t.run((ctx) => ctx.db.query("oauthAuthorizations").collect())).toEqual(
      [],
    );
  });

  test("the redirect URI must match exactly", async () => {
    const { t } = await twoConnectedTenants();
    for (const redirectUri of [
      "https://client.example/callback.evil", // suffixed
      "https://client.example/call", // truncated
      "https://client.example.evil/callback", // lookalike host
      "https://client.example/callback/", // trailing slash
      "http://client.example/callback", // downgraded scheme
      "https://client.example/callback?x=1", // extra query
    ]) {
      const response = await startAuthorization(t, { redirectUri });
      expect(response.status, `${redirectUri} was parked`).toBe(400);
    }
    expect((await startAuthorization(t)).status).toBe(200);
  });

  test("a loopback client's ephemeral port is ignored, and nothing else is", async () => {
    const { t } = await twoConnectedTenants();
    await registerClient(t, "mcp_cli", {
      redirectUris: ["http://127.0.0.1/callback"],
      applicationType: "native",
    });

    expect(
      (
        await startAuthorization(t, {
          clientId: "mcp_cli",
          redirectUri: "http://127.0.0.1:51763/callback",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await startAuthorization(t, {
          clientId: "mcp_cli",
          redirectUri: "http://127.0.0.1:51763/other",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await startAuthorization(t, {
          clientId: "mcp_cli",
          redirectUri: "https://127.0.0.1:51763/callback",
        })
      ).status,
    ).toBe(400);
  });

  test("refuses a client nobody registered", async () => {
    const { t } = await twoConnectedTenants();
    expect(
      (await startAuthorization(t, { clientId: "never-registered" })).status,
    ).toBe(400);
  });
});

describe("consent belongs to the person, not to the gateway", () => {
  test("the consent screen shows who is asking and where the code would go", async () => {
    const { t, alice } = await twoConnectedTenants();
    const started = await bodyOf(await startAuthorization(t));
    const request = await asUser(t, alice).query(
      api.functions.authorizations.getAuthorizationRequest,
      { requestId: started.requestId as string },
    );
    expect(request).toMatchObject({
      clientName: `Client ${CLIENT_A}`,
      redirectUri: REDIRECT_URI,
      scope: "context:read context:write",
      requestedWorkspaceSlug: "alpha",
    });
  });

  test("an unauthenticated caller learns nothing about a request id", async () => {
    const { t } = await twoConnectedTenants();
    const started = await bodyOf(await startAuthorization(t));
    expect(
      errorCode(
        await captureError(() =>
          t.query(api.functions.authorizations.getAuthorizationRequest, {
            requestId: started.requestId as string,
          }),
        ),
      ),
    ).toBe("NOT_AUTHENTICATED");
  });

  test("nobody can approve into a workspace they do not belong to", async () => {
    const { t, bob, aliceWs } = await twoConnectedTenants();
    const started = await bodyOf(await startAuthorization(t));
    const error = await captureError(() =>
      asUser(t, bob).action(api.functions.authorizations.approveAuthorization, {
        requestId: started.requestId as string,
        workspaceId: aliceWs,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
    // Nothing was armed.
    const row = await t.run((ctx) => ctx.db.query("oauthAuthorizations").first());
    expect(row?.status).toBe("pending");
    expect(row?.hashedCode).toBeUndefined();
  });

  test("the workspace comes from the approver, not from the parked request", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    // The request asked for bob's context by slug. It is a hint, nothing more.
    const { code } = await startAndApprove(
      t,
      { alice, aliceWs },
      { requestedWorkspaceSlug: "alphabet" },
    );
    const consumed = await bodyOf(
      await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    );
    expect((consumed.authorization as { workspaceId: string }).workspaceId).toBe(
      aliceWs,
    );
  });

  test("a request can only be approved once", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { requestId } = await startAndApprove(t, { alice, aliceWs });
    const error = await captureError(() =>
      asUser(t, alice).action(api.functions.authorizations.approveAuthorization, {
        requestId,
        workspaceId: aliceWs,
      }),
    );
    expect(errorCode(error)).toBe("AUTHORIZATION_REQUEST_NOT_FOUND");
  });
});

describe("/gateway/codes/consume", () => {
  test("returns the authorization once, with the PKCE challenge carried forward unchanged", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    );
    expect(body.authorization).toEqual({
      clientId: CLIENT_A,
      redirectUri: REDIRECT_URI,
      codeChallenge: await s256(VERIFIER),
      codeChallengeMethod: "S256",
      scope: "context:read context:write",
      resource: "https://mcp.context.test/mcp",
      workspaceId: aliceWs,
      userId: alice,
    });
    // The challenge that comes back is the one the client sent, and not the
    // one a different verifier would produce — the gateway's PKCE check is
    // only worth anything if this value survives the round trip untouched.
    expect((body.authorization as { codeChallenge: string }).codeChallenge).not.toBe(
      await s256(OTHER_VERIFIER),
    );
  });

  test("a replay a millisecond later sees what a code that never existed sees", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });
    await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A });

    const replay = await responseFingerprint(
      await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    );
    const neverExisted = await responseFingerprint(
      await gatewayPost(t, "/gateway/codes/consume", {
        code: "no-such-code",
        clientId: CLIENT_A,
      }),
    );
    expect(replay).toBe(neverExisted);
    expect(JSON.parse(replay.split("\n").pop() ?? "{}")).toEqual({
      authorization: null,
    });
  });

  /**
   * The atomicity claim, exercised rather than asserted. Both redemptions are
   * in flight at once; Convex mutations are serializable, so the second one
   * cannot see `approved`.
   */
  test("two concurrent redemptions of the same code: exactly one succeeds", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });

    const [first, second] = await Promise.all([
      gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
      gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    ]);
    const bodies = [await bodyOf(first), await bodyOf(second)];
    const winners = bodies.filter((body) => body.authorization !== null);
    expect(winners).toHaveLength(1);
    expect((winners[0].authorization as { workspaceId: string }).workspaceId).toBe(
      aliceWs,
    );
  });

  test("a code minted for another client is refused — and burned", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/codes/consume", {
          code,
          clientId: CLIENT_A_SIBLING,
        }),
      ),
    ).toEqual({ authorization: null });

    // A misused code is dead, not retryable: RFC 6749 §4.1.2. The rightful
    // client cannot spend it afterwards either.
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
      ),
    ).toEqual({ authorization: null });
  });

  test("an expired code is refused", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("oauthAuthorizations").first();
      if (row !== null) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
      ),
    ).toEqual({ authorization: null });
  });

  test("a parked request that nobody approved cannot be spent", async () => {
    const { t } = await twoConnectedTenants();
    await startAuthorization(t);
    // There is no code to guess, but even the request id is not one.
    const row = await t.run((ctx) => ctx.db.query("oauthAuthorizations").first());
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/codes/consume", {
          code: row!.requestId,
          clientId: CLIENT_A,
        }),
      ),
    ).toEqual({ authorization: null });
  });
});

/* -------------------------------------------------------------------------- */
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
/* 10. The whole flow, end to end                                             */
/* -------------------------------------------------------------------------- */

describe("the full authorization flow produces a working, isolated grant", () => {
  test("register → authorize → approve → consume → grant → session → binding", async () => {
    const { t, alice, aliceWs, bobWs } = await twoConnectedTenants();

    const { code } = await startAndApprove(t, { alice, aliceWs });
    const consumed = await bodyOf(
      await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    );
    const authorization = consumed.authorization as {
      workspaceId: string;
      userId: string;
      scope: string;
    };

    const accessToken = token("end_to_end");
    const refreshToken = `crt_end_to_end_${"0".repeat(18)}`;
    const created = await bodyOf(
      await gatewayPost(t, "/gateway/grants/create", {
        workspaceId: authorization.workspaceId,
        userId: authorization.userId,
        clientId: CLIENT_A,
        scopes: authorization.scope.split(" "),
        hashedRefreshToken: await hashToken(refreshToken),
        hashedAccessToken: await hashToken(accessToken),
        accessTokenExpiresAt: Date.now() + 3_600_000,
      }),
    );
    expect(typeof created.grantId).toBe("string");

    const session = await bodyOf(
      await gatewayPost(t, "/gateway/session", { accessToken }),
    );
    expect((session.session as { defaultWorkspaceId: string }).defaultWorkspaceId).toBe(
      aliceWs,
    );

    const binding = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken,
        expectedWorkspaceId: aliceWs,
      }),
    );
    expect((binding.binding as { bucket: string }).bucket).toBe("tenant-a");

    // …and it reaches only its own workspace.
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/binding", {
          accessToken,
          expectedWorkspaceId: bobWs,
        }),
      ),
    ).toEqual({ binding: null });
  });
});

/* -------------------------------------------------------------------------- */
/* 11. A narrowed approval survives the whole flow                            */
/* -------------------------------------------------------------------------- */

/**
 * The narrowing has to reach the session, not just the screen.
 *
 * A tick box that changes a database row and not the answer the gateway gets is
 * the same bug with a nicer picture, so each of these follows one approval all
 * the way to `/gateway/session` — the payload the gateway builds its enforcement
 * from — and asserts what came out the far end.
 */
describe("what the person approved is what the session carries", () => {
  async function sessionScopesFor(
    t: TestConvex,
    who: { alice: Id<"users">; aliceWs: Id<"workspaces"> },
    grantedScopes: string[],
    overrides: Record<string, unknown> = {},
  ): Promise<string[]> {
    const { code } = await startAndApproveWith(t, who, grantedScopes, overrides);
    const consumed = await bodyOf(
      await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    );
    const authorization = consumed.authorization as { workspaceId: string; userId: string; scope: string };

    const accessToken = token(`narrowed_${grantedScopes.length}_${Math.random()}`.slice(0, 40));
    await gatewayPost(t, "/gateway/grants/create", {
      workspaceId: authorization.workspaceId,
      userId: authorization.userId,
      clientId: CLIENT_A,
      // Exactly what the code carried. If `consumeAuthorizationCode` handed back
      // the *request* instead of the approval, this is where it would show up.
      scopes: authorization.scope.split(" "),
      hashedRefreshToken: await hashToken(`crt_narrowed_${accessToken}`),
      hashedAccessToken: await hashToken(accessToken),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });

    const session = await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken }));
    return (session.session as { scopes: string[] }).scopes;
  }

  test("a read-only approval of a read-and-write request arrives read-only", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    expect(await sessionScopesFor(t, { alice, aliceWs }, ["context:read"])).toEqual([
      "context:read",
    ]);
  });

  test("an approval that named no tier arrives with no tier", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    // Alice owns this context. Under the old model that alone made the grant
    // private-tier, and nothing recorded a decision because there was none.
    expect(
      await sessionScopesFor(t, { alice, aliceWs }, ["context:read", "context:write"]),
    ).not.toContain("context:private");
  });

  test("an owner who chose private-tier arrives carrying it", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    expect(
      await sessionScopesFor(t, { alice, aliceWs }, [
        "context:read",
        "context:write",
        "context:private",
      ]),
    ).toEqual(["context:read", "context:write", "context:private"]);
  });
});
