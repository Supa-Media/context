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

import { afterEach, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { hashToken } from "../../functions/lib/crypto";
import {
  asUser,
  createUser,
  createWorkspace,
  gatewayPost,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";

afterEach(() => {
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A token long enough to be a real one, and obviously not one. */
export function token(label: string): string {
  return `cat_${label}_${"0".repeat(Math.max(0, 34 - label.length))}`;
}

export const ACCESS_A = token("tenant_a_owner");
export const REFRESH_A = `crt_tenant_a_${"0".repeat(24)}`;
export const ACCESS_B = token("tenant_b_owner");
export const REFRESH_B = `crt_tenant_b_${"0".repeat(24)}`;
export const ACCESS_A_SIBLING = token("tenant_a_sibling");

export const CLIENT_A = "mcp_client_alpha";
export const CLIENT_A_SIBLING = "mcp_client_alpha_sibling";
export const CLIENT_B = "mcp_client_beta";

export const REDIRECT_URI = "https://client.example/callback";

/** Register a client through the real route, exactly as the gateway would. */
export async function registerClient(
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
export async function seedConnectedClient(
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
export async function twoConnectedTenants() {
  const t = setupTest();
  const alice = await createUser(t, "alice@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");

  const aliceWs = await createWorkspace(t, alice, "alfa", {
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
export async function danglingWorkspaceId(t: TestConvex): Promise<Id<"workspaces">> {
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
export async function removeMembership(
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

export async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text());
}

/**
 * `startAuthorization`, `startAndApprove` and `startAndApproveWith` are used
 * by `authorizeFlow.test.ts` (their original home), and also by
 * `clients.test.ts` ("a dump of the grants table plus the gateway secret is
 * inert") and `linksAndFlow.test.ts` (the end-to-end flow and the narrowed-
 * approval tests). They live here rather than in `authorizeFlow.test.ts` for
 * that reason — moved, not copied.
 */

/** base64url of the SHA-256 of a verifier — an S256 PKCE challenge. */
export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier) as BufferSource,
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const VERIFIER = "a".repeat(64);

export async function startAuthorization(
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
    requestedWorkspaceSlug: "alfa",
    ...overrides,
  });
}

/** Park a request, approve it while narrowing, and pull the code out. */
export async function startAndApproveWith(
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
export async function startAndApprove(
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

