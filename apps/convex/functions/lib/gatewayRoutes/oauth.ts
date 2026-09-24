/**
 * The OAuth routes: client registration and lookup, parking an authorization
 * request, spending a code, and creating, rotating and revoking a grant.
 *
 * Split out of `http.ts`, which keeps every route declared and registered
 * under the same name and path, built by the same factory, and passes these
 * handlers to it; this module registers nothing. The factory's secret check
 * still runs before any of this code.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken, TOKEN_HASH_PATTERN } from "../crypto";
import {
  badRequest,
  consentUrlFor,
  json,
  nullableStringField,
  redirectUriIsAcceptable,
  stringArrayField,
  stringField,
  timestampField,
  tokenHashField,
} from "../gatewayAuth";
import { serverError } from "./responses";

/**
 * Idempotent on `clientId`: a client that re-registers after a redeploy
 * updates its row rather than forking into a second identity that orphans its
 * grants.
 *
 * The redirect URIs are re-validated here even though the gateway validated
 * them, because the gateway is the party that rule constrains. A registered
 * URI is where an authorization code gets delivered; accepting an http one on
 * a public host would put a code on the wire in cleartext.
 */
export async function gatewayClientsRegisterHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const clientId = stringField(body, "clientId");
  const clientName = stringField(body, "clientName");
  const redirectUris = stringArrayField(body, "redirectUris");
  const authMethod = body.tokenEndpointAuthMethod;

  // `null` is a public client. A string must be a real hash — a secret that
  // is not a digest means the gateway sent a plaintext one.
  const rawSecret = body.hashedClientSecret;
  const hashedClientSecret =
    rawSecret === null
      ? null
      : typeof rawSecret === "string" && TOKEN_HASH_PATTERN.test(rawSecret)
        ? rawSecret
        : undefined;

  if (
    clientId === null ||
    clientName === null ||
    redirectUris === null ||
    redirectUris.length === 0 ||
    !redirectUris.every(redirectUriIsAcceptable) ||
    hashedClientSecret === undefined ||
    (authMethod !== "none" && authMethod !== "client_secret_post")
  ) {
    return badRequest();
  }

  const grantTypes = stringArrayField(body, "grantTypes") ?? undefined;
  const responseTypes = stringArrayField(body, "responseTypes") ?? undefined;
  const scope = stringField(body, "scope") ?? undefined;
  const applicationType =
    body.applicationType === "native" || body.applicationType === "web"
      ? body.applicationType
      : undefined;

  /*
    A rate-limited registration is a 429 and not a 500.

    `consumeRateLimit` throws a `ConvexError`, and an uncaught one out of an
    httpAction is a 500 — which tells the gateway, and through it the client,
    that this server is broken rather than that they went too fast. RFC 6749
    clients back off on 429 and retry; on 500 they are entitled to hammer.
    `Retry-After` carries the window the limiter already computed, so nobody
    has to guess.

    Only RATE_LIMITED is translated. Anything else is a real failure and keeps
    its 500 — swallowing the rest here would turn a broken control plane into a
    quiet "try later", which is the shape this repository keeps a list of.
  */
  try {
    await ctx.runMutation(internal.functions.grants.registerClient, {
    clientId,
    clientName,
    redirectUris,
    hashedClientSecret,
    tokenEndpointAuthMethod: authMethod,
    grantTypes,
    responseTypes,
    scope,
    applicationType,
    // RFC 7591's `software_id`, carried as the client sent it. The gateway has
    // already bounded its length and alphabet; this route stores a string and
    // draws no conclusion from it.
    softwareId: stringField(body, "softwareId") ?? undefined,
    // What the registration rate limit is keyed on. Passed through rather than
    // read here, because the connecting address is the gateway's to know: this
    // route's own peer is always the gateway.
    registrantKey: stringField(body, "registrantKey") ?? undefined,
    });
  } catch (error) {
    const data = error instanceof ConvexError ? (error.data as { code?: unknown; retryAfterMs?: unknown }) : null;
    if (data?.code !== "RATE_LIMITED") throw error;
    const retryAfterMs = typeof data.retryAfterMs === "number" ? data.retryAfterMs : 0;
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      },
    });
  }
  return json({ ok: true });
}

export async function gatewayClientsGetHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const clientId = stringField(body, "clientId");
  if (clientId === null) return json({ client: null });

  const client = await ctx.runQuery(internal.functions.grants.getClient, {
    clientId,
  });
  return json({ client });
}

/**
 * The gateway hands the request over and its involvement ends until the token
 * call. The *human* authenticates against our own app, at `consentUrl`.
 *
 * `startAuthorization` re-checks the client and the redirect URI and answers
 * `null` for anything it will not park. The gateway turns a non-200 into
 * `server_error` for the person in the browser, which is the only thing it
 * could usefully say.
 */
export async function gatewayAuthorizeStartHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const clientId = stringField(body, "clientId");
  const redirectUri = stringField(body, "redirectUri");
  const codeChallenge = stringField(body, "codeChallenge");
  const codeChallengeMethod = stringField(body, "codeChallengeMethod");
  const scope = stringField(body, "scope");
  const state = nullableStringField(body, "state");
  const resource = nullableStringField(body, "resource");
  const requestedWorkspaceSlug = nullableStringField(
    body,
    "requestedWorkspaceSlug",
  );

  if (
    clientId === null ||
    redirectUri === null ||
    codeChallenge === null ||
    codeChallengeMethod === null ||
    scope === null ||
    !state.ok ||
    !resource.ok ||
    !requestedWorkspaceSlug.ok
  ) {
    return badRequest();
  }

  const requestId = await ctx.runMutation(
    internal.functions.controlPlane.startAuthorization,
    {
      clientId,
      redirectUri,
      state: state.value,
      codeChallenge,
      codeChallengeMethod,
      scope,
      resource: resource.value,
      requestedWorkspaceSlug: requestedWorkspaceSlug.value,
    },
  );
  if (requestId === null) return badRequest();

  let consentUrl: string;
  try {
    consentUrl = consentUrlFor(requestId);
  } catch {
    // A deployment with no consent origin configured cannot host consent. It
    // refuses rather than redirecting a real person's browser somewhere
    // guessed.
    return serverError();
  }
  return json({ requestId, consentUrl });
}

/**
 * The code is presented, so it arrives verbatim and is hashed here. The
 * mutation marks it consumed in the same transaction that reads it, so two
 * concurrent redemptions cannot both succeed and a replay a millisecond later
 * sees exactly what a code that never existed sees.
 */
export async function gatewayCodesConsumeHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const code = stringField(body, "code");
  const clientId = stringField(body, "clientId");
  if (code === null || clientId === null) return json({ authorization: null });

  const authorization = await ctx.runMutation(
    internal.functions.controlPlane.consumeAuthorizationCode,
    { hashedCode: await hashToken(code), clientId },
  );
  return json({ authorization });
}

/**
 * Both token hashes are minted values, so they arrive already hashed — the
 * plaintext exists in the token response and in the client, and nowhere else.
 *
 * `createGrant` re-checks membership: an authorization code can outlive the
 * moment it was issued, and someone removed from a workspace in between must
 * not end up holding a working grant to it. That refusal comes back as a 400,
 * which the gateway turns into a failed token exchange.
 */
export async function gatewayGrantsCreateHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const workspaceId = stringField(body, "workspaceId");
  const userId = stringField(body, "userId");
  const clientId = stringField(body, "clientId");
  const scopes = stringArrayField(body, "scopes");
  const hashedRefreshToken = tokenHashField(body, "hashedRefreshToken");
  const hashedAccessToken = tokenHashField(body, "hashedAccessToken");
  const accessTokenExpiresAt = timestampField(body, "accessTokenExpiresAt");

  if (
    workspaceId === null ||
    userId === null ||
    clientId === null ||
    scopes === null ||
    scopes.length === 0 ||
    hashedRefreshToken === null ||
    hashedAccessToken === null ||
    accessTokenExpiresAt === null
  ) {
    return badRequest();
  }

  let grantId: string;
  try {
    grantId = await ctx.runMutation(internal.functions.grants.createGrant, {
      workspaceId,
      userId,
      clientId,
      scopes,
      hashedRefreshToken,
      hashedAccessToken,
      accessTokenExpiresAt,
    });
  } catch {
    // `WORKSPACE_NOT_FOUND`, `CLIENT_NOT_REGISTERED`, and a malformed hash all
    // land here as the same refusal. Relaying which one would tell a caller
    // holding the gateway secret whether a workspace id it guessed is real.
    return badRequest();
  }
  return json({ grantId });
}

/**
 * The presented refresh token arrives verbatim and is hashed here; the new
 * pair arrives already hashed. Reuse of an already-rotated token revokes the
 * grant rather than merely failing — see `rotateGrant`.
 */
export async function gatewayGrantsRotateHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const refreshToken = stringField(body, "refreshToken");
  const clientId = stringField(body, "clientId");
  // A token the *client* supplied: a missing or malformed one is answered like
  // any other bad token, not like a malformed request.
  if (refreshToken === null || clientId === null) return json({ grant: null });

  const newHashedRefreshToken = tokenHashField(body, "newHashedRefreshToken");
  const newHashedAccessToken = tokenHashField(body, "newHashedAccessToken");
  const accessTokenExpiresAt = timestampField(body, "accessTokenExpiresAt");
  // These are values the *gateway* minted. Getting them wrong is a gateway
  // bug, and a bug is worth a 400 rather than a silent refusal that looks to
  // the person like their session simply ended.
  if (
    newHashedRefreshToken === null ||
    newHashedAccessToken === null ||
    accessTokenExpiresAt === null
  ) {
    return badRequest();
  }

  const rawScopes = body.scopes;
  if (rawScopes !== null && rawScopes !== undefined && !Array.isArray(rawScopes)) {
    return badRequest();
  }
  const scopes =
    rawScopes === null || rawScopes === undefined
      ? null
      : stringArrayField(body, "scopes");
  if (rawScopes !== null && rawScopes !== undefined && scopes === null) {
    return badRequest();
  }

  const grant = await ctx.runMutation(
    internal.functions.controlPlane.rotateGrant,
    {
      hashedRefreshToken: await hashToken(refreshToken),
      clientId,
      newHashedRefreshToken,
      newHashedAccessToken,
      accessTokenExpiresAt,
      scopes,
    },
  );
  return json({ grant });
}

/**
 * Revokes exactly one grant — the one that token belongs to — and touches
 * nothing else. Sibling grants (same person, same workspace, different AI
 * client) keep working; that is the entire point of per-client grants.
 *
 * RFC 7009 §2.2 wants 200 whether or not anything matched, so the gateway
 * discards `revoked` for the client's benefit and keeps it only for tests.
 */
export async function gatewayGrantsRevokeHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const token = stringField(body, "token");
  const clientId = stringField(body, "clientId");
  const tokenType = body.tokenType === "access" ? "access" : "refresh";
  if (token === null || clientId === null) return json({ revoked: false });

  const revoked = await ctx.runMutation(
    internal.functions.controlPlane.revokeGrantByToken,
    { hashedToken: await hashToken(token), tokenType, clientId },
  );
  return json({ revoked });
}
