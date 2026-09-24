/**
 * The OAuth half of a grant: parking an authorization, redeeming its code,
 * rotating a grant's tokens and revoking one.
 *
 * Split out of `functions/controlPlane.ts`, which keeps every registered
 * function and wires these handlers to them; this module registers none. It is on the gateway's path,
 * so `scripts/check-exit-is-ungated.mjs` scans it exactly as it scans that
 * file.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx } from "../../../_generated/server";
import { clampAccessTokenExpiry } from "../consentScopes";
import { TOKEN_HASH_PATTERN } from "../crypto";
import {
  AUTHORIZATION_TTL_MS,
  randomOpaqueToken,
  redirectUriMatches,
} from "../gatewayAuth";
import { recordAudit } from "../audit";
import { getMembership } from "../workspaceAuth";

/**
 * An S256 PKCE challenge is the base64url of a SHA-256 digest: 43 characters,
 * no padding. Checking the shape here means a client that sent a verifier
 * where a challenge belongs fails at the authorization request rather than at
 * the token exchange, when the code has already been minted.
 */
export const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const startAuthorizationArgs = {
  clientId: v.string(),
  redirectUri: v.string(),
  state: v.union(v.string(), v.null()),
  codeChallenge: v.string(),
  codeChallengeMethod: v.string(),
  scope: v.string(),
  resource: v.union(v.string(), v.null()),
  requestedWorkspaceSlug: v.union(v.string(), v.null()),
};

export const startAuthorizationReturns = v.union(v.null(), v.string());

/**
 * Park a validated authorization request, and get out of the way.
 *
 * The gateway has checked the client and the redirect URI by the time it calls
 * this; we check both again anyway, because the gateway is precisely the party
 * this check constrains. A caller holding the gateway secret must not be able
 * to park a request pointing at a redirect URI the client never registered —
 * that is a confused deputy with our consent screen on the front of it.
 *
 * Returns `null` rather than throwing for every refusal. The gateway turns a
 * non-200 into `server_error` for the person in the browser, and there is
 * nothing about *which* check failed that it could usefully relay.
 */
export async function startAuthorizationHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof startAuthorizationArgs>,
) {
  // `plain` is rejected outright rather than accepted-and-discouraged: under
  // `plain` the challenge *is* the verifier, so anyone who saw the
  // authorization request can complete the exchange — the entire attack PKCE
  // exists to stop.
  if (args.codeChallengeMethod !== "S256") return null;
  if (!CODE_CHALLENGE_PATTERN.test(args.codeChallenge)) return null;

  const client = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
    .unique();
  if (client === null) return null;

  const matched = client.redirectUris.some((registered) =>
    redirectUriMatches(registered, args.redirectUri),
  );
  if (!matched) return null;

  const now = Date.now();
  const requestId = randomOpaqueToken(18);
  await ctx.db.insert("oauthAuthorizations", {
    requestId,
    clientId: args.clientId,
    redirectUri: args.redirectUri,
    state: args.state,
    codeChallenge: args.codeChallenge,
    codeChallengeMethod: "S256",
    scope: args.scope,
    resource: args.resource,
    requestedWorkspaceSlug: args.requestedWorkspaceSlug,
    status: "pending",
    expiresAt: now + AUTHORIZATION_TTL_MS,
    createdAt: now,
  });
  return requestId;
}

export const consumeAuthorizationCodeArgs = { hashedCode: v.string(), clientId: v.string() };

export const consumeAuthorizationCodeReturns = v.union(
  v.null(),
  v.object({
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.string(),
    scope: v.string(),
    resource: v.union(v.string(), v.null()),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
  }),
);

/**
 * Spend an authorization code, once, atomically.
 *
 * The whole point is the ordering: the row is moved to `consumed` **in the
 * same transaction that read it**, before any of the validity checks run. Two
 * concurrent redemptions therefore cannot both see `approved`, and a code that
 * fails a check is dead rather than retryable — RFC 6749 §4.1.2 wants a
 * misused code gone, not available for another guess.
 *
 * The gateway verifies PKCE *after* this call, so a wrong verifier also burns
 * the code. That is deliberate, and it is why burning happens first here.
 */
export async function consumeAuthorizationCodeHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof consumeAuthorizationCodeArgs>,
) {
  if (!TOKEN_HASH_PATTERN.test(args.hashedCode)) return null;

  const record = await ctx.db
    .query("oauthAuthorizations")
    .withIndex("by_hashedCode", (q) => q.eq("hashedCode", args.hashedCode))
    .unique();
  // A code that never existed and a code already spent a millisecond ago are
  // the same answer.
  if (record === null || record.status !== "approved") return null;

  // Burn first. Everything below can only turn a success into a `null`.
  await ctx.db.patch(record._id, { status: "consumed", consumedAt: Date.now() });

  if (record.expiresAt <= Date.now()) return null;
  if (record.clientId !== args.clientId) return null;
  if (record.workspaceId === undefined || record.userId === undefined) return null;

  return {
    clientId: record.clientId,
    redirectUri: record.redirectUri,
    codeChallenge: record.codeChallenge,
    codeChallengeMethod: record.codeChallengeMethod,
    /**
     * **What the person approved**, not what the client asked for.
     *
     * `applyApproval` already narrowed the request to what was ticked and
     * clamped it to what the approver's role could hand over, so this is the
     * set the grant must carry — a scope the person unticked must not
     * reappear here and become a grant.
     *
     * The fallback exists for a row approved before `grantedScope` was a
     * field, which can be at most one ten-minute window old. It cannot widen
     * anything: `context:private` was not grantable when such a row was
     * written, so the widest set it reconstructs is the old read/write pair
     * at `team` tier.
     */
    scope: record.grantedScope ?? record.scope,
    resource: record.resource,
    workspaceId: record.workspaceId,
    userId: record.userId,
  };
}

export const rotateGrantArgs = {
  hashedRefreshToken: v.string(),
  clientId: v.string(),
  newHashedRefreshToken: v.string(),
  newHashedAccessToken: v.string(),
  accessTokenExpiresAt: v.number(),
  scopes: v.union(v.array(v.string()), v.null()),
};

export const rotateGrantReturns = v.union(
  v.null(),
  v.object({
    grantId: v.id("oauthGrants"),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    clientId: v.string(),
    scopes: v.array(v.string()),
  }),
);

/**
 * Refresh, with mandatory rotation and reuse detection.
 *
 * OAuth 2.1 §4.3.1 requires rotation for public clients, which makes reuse
 * detection not optional: **a refresh token presented after it has been
 * rotated away means the token leaked.** Two parties now hold it, we cannot
 * tell which one is the thief, and refusing the request would leave the thief
 * holding a working grant. So the grant dies.
 *
 * The whole thing is one transaction. There is no window in which both the old
 * and the new refresh token work, and none in which the old one has been
 * retired but the new one is not yet recorded.
 */
export async function rotateGrantHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof rotateGrantArgs>,
) {
  if (!TOKEN_HASH_PATTERN.test(args.hashedRefreshToken)) return null;
  if (
    !TOKEN_HASH_PATTERN.test(args.newHashedRefreshToken) ||
    !TOKEN_HASH_PATTERN.test(args.newHashedAccessToken)
  ) {
    return null;
  }

  const grant = await ctx.db
    .query("oauthGrants")
    .withIndex("by_refresh_token", (q) =>
      q.eq("hashedRefreshToken", args.hashedRefreshToken),
    )
    .unique();

  if (grant === null) {
    // Not a current token. Is it one this grant already retired?
    const reused = await ctx.db
      .query("oauthGrants")
      .withIndex("by_previous_refresh_token", (q) =>
        q.eq("previousHashedRefreshToken", args.hashedRefreshToken),
      )
      .unique();
    if (reused !== null && reused.status === "active") {
      await ctx.db.patch(reused._id, {
        status: "revoked",
        revokedAt: Date.now(),
      });
      await recordAudit(ctx, {
        workspaceId: reused.workspaceId,
        actorUserId: reused.userId,
        actorClientId: reused.clientId,
        action: "grant.revoked",
        // Names the reason, never the token or its hash. Someone reading
        // this trail needs to know a leak was detected, not what leaked.
        details: { reason: "refresh_token_reuse" },
      });
    }
    return null;
  }

  if (grant.status !== "active") return null;
  // A client may only refresh its own grant.
  if (grant.clientId !== args.clientId) return null;
  // Membership is re-checked here too: someone removed from a shared context
  // must not be able to refresh their way back in.
  const membership = await getMembership(ctx, grant.workspaceId, grant.userId);
  if (membership === null) return null;

  // Narrowing only. A refresh may drop scopes; it may never add one the
  // person never granted, so the request is intersected with what is held.
  //
  // That intersection is also what stops a refresh from being a way to change
  // the privacy tier. `context:private` is an ordinary member of this array,
  // so a client asking for it on refresh gets it only if the grant already
  // had it — which means only if a person ticked it on the consent screen.
  // There is no other door into private-tier.
  const narrowed =
    args.scopes !== null && args.scopes.length > 0
      ? args.scopes.filter((scope) => grant.scopes.includes(scope))
      : null;
  const scopes = narrowed !== null && narrowed.length > 0 ? narrowed : grant.scopes;

  await ctx.db.patch(grant._id, {
    previousHashedRefreshToken: grant.hashedRefreshToken,
    hashedRefreshToken: args.newHashedRefreshToken,
    hashedAccessToken: args.newHashedAccessToken,
    // Clamped on the way in, as `createGrant` does: a refresh is the same
    // actor asking for the same thing a second time.
    accessTokenExpiresAt: clampAccessTokenExpiry(args.accessTokenExpiresAt, Date.now()),
    scopes,
    lastUsedAt: Date.now(),
  });

  return {
    grantId: grant._id,
    workspaceId: grant.workspaceId,
    userId: grant.userId,
    clientId: args.clientId,
    scopes,
  };
}

export const revokeGrantByTokenArgs = {
  hashedToken: v.string(),
  tokenType: v.union(v.literal("access"), v.literal("refresh")),
  clientId: v.string(),
};

export const revokeGrantByTokenReturns = v.boolean();

/**
 * RFC 7009 revocation — the per-client "unplug this one" lever.
 *
 * Revokes exactly one grant, the one that token belongs to, and touches
 * nothing else. Sibling grants — same person, same workspace, a different AI
 * client — keep working, which is the entire reason MCP access is OAuth rather
 * than a shared token.
 *
 * A grant belonging to a different `clientId` than the one authenticating is
 * never revoked: otherwise any registered client could disconnect any other.
 */
export async function revokeGrantByTokenHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof revokeGrantByTokenArgs>,
) {
  if (!TOKEN_HASH_PATTERN.test(args.hashedToken)) return false;

  const grant =
    args.tokenType === "access"
      ? await ctx.db
          .query("oauthGrants")
          .withIndex("by_access_token", (q) =>
            q.eq("hashedAccessToken", args.hashedToken),
          )
          .unique()
      : await ctx.db
          .query("oauthGrants")
          .withIndex("by_refresh_token", (q) =>
            q.eq("hashedRefreshToken", args.hashedToken),
          )
          .unique();

  if (grant === null) return false;
  if (grant.clientId !== args.clientId) return false;
  if (grant.status !== "active") return false;

  await ctx.db.patch(grant._id, { status: "revoked", revokedAt: Date.now() });
  await recordAudit(ctx, {
    workspaceId: grant.workspaceId,
    actorUserId: grant.userId,
    actorClientId: grant.clientId,
    action: "grant.revoked",
    details: { reason: "client_revocation" },
  });
  return true;
}
