/**
 * HTTP routes.
 *
 * Three families live here: the auth framework's own callbacks, the nine
 * control-plane routes the MCP gateway resolves every request through, and the
 * three ingest routes the Cloudflare Email Worker calls.
 *
 * ============================================================================
 * THE GATEWAY ROUTES
 * ============================================================================
 *
 * `apps/mcp/src/controlPlane.js` is the normative contract — request shapes,
 * response shapes, and the reasoning. `apps/mcp/test/controlPlaneStub.mjs` is
 * an executable reference implementation of it. These routes must be
 * behaviourally indistinguishable from that stub. If they and it disagree, one
 * of them is a bug and it is probably this file.
 *
 * Four properties are load-bearing, and each of them is easy to lose in a
 * refactor that looks like a tidy-up:
 *
 * 1. **The gateway secret is necessary and never sufficient.** Every route
 *    below is built by `gatewayRoute`, which refuses anything that does not
 *    carry it — that is proof #1, "this caller is the gateway". It authorizes
 *    *nothing else*. `/gateway/binding` additionally requires the end user's
 *    access token and derives the workspace from the grant that token resolves
 *    to; `expectedWorkspaceId` can only veto, never select. A leaked gateway
 *    secret on its own must yield no credential, no session, and no
 *    enumeration.
 *
 * 2. **Presented tokens arrive verbatim and are hashed here, on arrival.** An
 *    access token, a refresh token, a revocation token, and an authorization
 *    code all reach these routes in the clear over TLS and are turned into a
 *    SHA-256 digest before they touch anything else. Nothing downstream ever
 *    receives a raw token. Tokens the gateway *minted* arrive already hashed,
 *    because only the client needs the plaintext. That asymmetry is what makes
 *    a dump of `oauthGrants` inert.
 *
 * 3. **Every negative is the same negative.** `{ "session": null }`,
 *    `{ "binding": null }`, and `{ "authorization": null }` are built in one
 *    place each and are byte-identical across every reason they can occur.
 *    Distinguishing "not yours" from "does not exist" turns a route into an
 *    oracle for the customer list.
 *
 * 4. **No route returns more than one workspace's anything.** There is no call
 *    shape here that lists, searches, or enumerates. Bulk extraction is meant
 *    to be impossible because the surface has no shape for it, not because
 *    nobody has tried.
 *
 * `__tests__/structure.test.ts` reads this file and enforces (1) structurally,
 * along with the rule that only an enumerated route may reach a decrypted
 * storage credential.
 *
 * ============================================================================
 * THE INGEST ROUTES
 * ============================================================================
 *
 * `infra/email-worker/src/controlPlane.ts` is the normative contract, and
 * `functions/ingestionGateway.ts` holds the reasoning for what they may do.
 * Three things about them are worth stating here, where the routes are:
 *
 * 1. **A different secret.** They are built by `emailWorkerRoute`, not
 *    `gatewayRoute`, and the two secrets do not substitute for one another. A
 *    stolen email-worker secret must not become a working MCP gateway.
 *
 * 2. **They relax the two-proof rule, and that is a decision, not an
 *    oversight.** An inbound email carries no user access token — nobody is
 *    present and nothing was authorized just now — so proof #2 cannot exist in
 *    the form `/gateway/binding` uses. What is kept is its important half:
 *    `/gateway/ingest/resolve` takes a *name a sender typed* and mints a ticket
 *    for whatever that name resolved to; `/gateway/ingest/binding` takes only
 *    that ticket. No field in either request can name a context, so a holder of
 *    the worker secret has no vocabulary for "give me the shared context
 *    `acme-board`" — and no such context could answer anyway, because mail
 *    lands in a personal context and nowhere else.
 *
 * 3. **`/gateway/ingest/binding` is the second internet-facing path to a
 *    decrypted credential**, and it is enumerated as such in
 *    `__tests__/structure.test.ts`. That file's `CREDENTIAL_HTTP_ROUTES`
 *    comment says a second entry "means a second internet-facing path to other
 *    people's bucket keys". It does. The residual risk is written out in full
 *    in the worker's contract and is bounded by: personal contexts only,
 *    ingestion-enabled owners only, a per-name rate limit on resolve, and a
 *    ticket that expires in five minutes and buys exactly one credential.
 */

import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { hashToken, TOKEN_HASH_PATTERN } from "./functions/lib/crypto";
import {
  badRequest,
  consentUrlFor,
  json,
  nullableStringField,
  randomOpaqueToken,
  readJsonBody,
  redirectUriIsAcceptable,
  requestIsFromEmailWorker,
  requestIsFromGateway,
  stringArrayField,
  stringField,
  timestampField,
  tokenHashField,
  unauthorized,
} from "./functions/lib/gatewayAuth";

const http = httpRouter();

// Auth routes (handles OTP verification callbacks)
auth.addHttpRoutes(http);

/**
 * Wrap a control-plane handler so it cannot be reached without the gateway
 * secret.
 *
 * A factory rather than a line at the top of each handler, deliberately: nine
 * handlers each remembering to check is nine chances to forget, and the tenth
 * route somebody adds in a hurry is the one that does. Here the check is not
 * something a route *does*, it is something a route *is* —
 * `__tests__/structure.test.ts` asserts that every exported route in this file
 * is built by this factory.
 *
 * The refusal carries no detail. "No header", "wrong scheme", and "wrong
 * secret" are one answer, because a caller could not act on the difference and
 * an attacker could.
 */
function gatewayRoute(
  handler: (
    ctx: ActionCtx,
    body: Record<string, unknown>,
  ) => Promise<Response>,
) {
  return httpAction(async (ctx, request) => {
    if (!(await requestIsFromGateway(request))) return unauthorized();
    const body = await readJsonBody(request);
    if (body === null) return badRequest();
    return await handler(ctx, body);
  });
}

/**
 * The same wrapper, for the email worker's own secret.
 *
 * A sibling factory rather than a parameter on `gatewayRoute`, so that which
 * secret opens which route is visible at the route's own declaration and not
 * buried in an argument. `__tests__/structure.test.ts` enumerates both factories
 * and asserts that every route in this file is built by one of them, and that
 * each one really does check a secret — so adding a third door is a diff to that
 * file, exactly like adding a credential route is.
 */
function emailWorkerRoute(
  handler: (
    ctx: ActionCtx,
    body: Record<string, unknown>,
  ) => Promise<Response>,
) {
  return httpAction(async (ctx, request) => {
    if (!(await requestIsFromEmailWorker(request))) return unauthorized();
    const body = await readJsonBody(request);
    if (body === null) return badRequest();
    return await handler(ctx, body);
  });
}

/** Something on our side broke. Says so, and says nothing else. */
function serverError(): Response {
  return json({ error: "server_error" }, 500);
}

/* -------------------------------------------------------------------------- */
/* 1. POST /gateway/session — resolve an access token to a session            */
/* -------------------------------------------------------------------------- */

/**
 * The same `{ "session": null }` covers an unknown token, a revoked grant, an
 * expired token, a grant whose user is no longer a member, and a client that
 * has been removed. `resolveGrantByAccessToken` re-checks membership on every
 * call, which is what makes removing someone from a shared context cut off
 * their already-issued clients immediately.
 *
 * `lastUsedAt` is stamped afterwards and its failure is swallowed: the contract
 * says the stamp MUST NOT fail the resolution. It powers "last seen 3 minutes
 * ago" next to a connected client, which is how a person notices a client they
 * do not recognize.
 */
export const gatewaySession = gatewayRoute(async (ctx, body) => {
  const accessToken = stringField(body, "accessToken");
  if (accessToken === null) return json({ session: null });

  const session = await ctx.runQuery(
    internal.functions.controlPlane.resolveGrantByAccessToken,
    { hashedAccessToken: await hashToken(accessToken) },
  );
  if (session === null) return json({ session: null });

  try {
    await ctx.runMutation(internal.functions.grants.touchGrant, {
      grantId: session.grantId,
    });
  } catch {
    // Deliberately swallowed. A failed bookkeeping write must not log someone
    // out of their AI client.
  }

  return json({
    session: {
      grantId: session.grantId,
      clientId: session.clientId,
      actorUserId: session.actorUserId,
      scopes: session.scopes,
      expiresAt: session.expiresAt,
      defaultWorkspaceId: session.workspaceId,
      // A *set*, with one member today. The `/@slug/mcp` path form selects
      // within it, and it must never contain a workspace this grant does not
      // cover.
      workspaces: [
        {
          workspaceId: session.workspaceId,
          slug: session.slug,
          role: session.role,
        },
      ],
    },
  });
});

/* -------------------------------------------------------------------------- */
/* 2. POST /gateway/binding — fetch a workspace's storage binding            */
/* -------------------------------------------------------------------------- */

/**
 * THE TWO-FACTOR ROUTE. Read `controlPlane.js` before changing anything here.
 *
 * `accessToken` is the authority; `expectedWorkspaceId` is not. The workspace
 * is derived from the grant the token resolves to, inside
 * `openStorageBinding`, and the expected id is compared against it and used
 * for nothing else. There is no path in which it selects a row.
 *
 * This is the one route whose response contains a decrypted secret. It is
 * fetched per request and never cached, on either side.
 */
export const gatewayBinding = gatewayRoute(async (ctx, body) => {
  const accessToken = stringField(body, "accessToken");
  const expected = nullableStringField(body, "expectedWorkspaceId");
  // A malformed request is answered exactly like an unknown token. There is
  // nothing here worth distinguishing, and a 400 would tell a caller holding
  // the gateway secret which of its two proofs was the bad one.
  if (accessToken === null || !expected.ok) return json({ binding: null });

  const binding = await ctx.runAction(
    internal.functions.controlPlane.openStorageBinding,
    {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: expected.value,
    },
  );
  return json({ binding });
});

/* -------------------------------------------------------------------------- */
/* 3. POST /gateway/clients/register — RFC 7591 dynamic client registration  */
/* -------------------------------------------------------------------------- */

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
export const gatewayClientsRegister = gatewayRoute(async (ctx, body) => {
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
  });
  return json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/* 4. POST /gateway/clients/get — look up a registered client                */
/* -------------------------------------------------------------------------- */

export const gatewayClientsGet = gatewayRoute(async (ctx, body) => {
  const clientId = stringField(body, "clientId");
  if (clientId === null) return json({ client: null });

  const client = await ctx.runQuery(internal.functions.grants.getClient, {
    clientId,
  });
  return json({ client });
});

/* -------------------------------------------------------------------------- */
/* 5. POST /gateway/authorize/start — park a validated authorization request */
/* -------------------------------------------------------------------------- */

/**
 * The gateway hands the request over and its involvement ends until the token
 * call. The *human* authenticates against our own app, at `consentUrl`.
 *
 * `startAuthorization` re-checks the client and the redirect URI and answers
 * `null` for anything it will not park. The gateway turns a non-200 into
 * `server_error` for the person in the browser, which is the only thing it
 * could usefully say.
 */
export const gatewayAuthorizeStart = gatewayRoute(async (ctx, body) => {
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
});

/* -------------------------------------------------------------------------- */
/* 6. POST /gateway/codes/consume — atomically spend an authorization code   */
/* -------------------------------------------------------------------------- */

/**
 * The code is presented, so it arrives verbatim and is hashed here. The
 * mutation marks it consumed in the same transaction that reads it, so two
 * concurrent redemptions cannot both succeed and a replay a millisecond later
 * sees exactly what a code that never existed sees.
 */
export const gatewayCodesConsume = gatewayRoute(async (ctx, body) => {
  const code = stringField(body, "code");
  const clientId = stringField(body, "clientId");
  if (code === null || clientId === null) return json({ authorization: null });

  const authorization = await ctx.runMutation(
    internal.functions.controlPlane.consumeAuthorizationCode,
    { hashedCode: await hashToken(code), clientId },
  );
  return json({ authorization });
});

/* -------------------------------------------------------------------------- */
/* 7. POST /gateway/grants/create — a grant at the end of a token exchange   */
/* -------------------------------------------------------------------------- */

/**
 * Both token hashes are minted values, so they arrive already hashed — the
 * plaintext exists in the token response and in the client, and nowhere else.
 *
 * `createGrant` re-checks membership: an authorization code can outlive the
 * moment it was issued, and someone removed from a workspace in between must
 * not end up holding a working grant to it. That refusal comes back as a 400,
 * which the gateway turns into a failed token exchange.
 */
export const gatewayGrantsCreate = gatewayRoute(async (ctx, body) => {
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
});

/* -------------------------------------------------------------------------- */
/* 8. POST /gateway/grants/rotate — refresh, with mandatory rotation         */
/* -------------------------------------------------------------------------- */

/**
 * The presented refresh token arrives verbatim and is hashed here; the new
 * pair arrives already hashed. Reuse of an already-rotated token revokes the
 * grant rather than merely failing — see `rotateGrant`.
 */
export const gatewayGrantsRotate = gatewayRoute(async (ctx, body) => {
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
});

/* -------------------------------------------------------------------------- */
/* 9. POST /gateway/grants/revoke — RFC 7009                                 */
/* -------------------------------------------------------------------------- */

/**
 * Revokes exactly one grant — the one that token belongs to — and touches
 * nothing else. Sibling grants (same person, same workspace, different AI
 * client) keep working; that is the entire point of per-client grants.
 *
 * RFC 7009 §2.2 wants 200 whether or not anything matched, so the gateway
 * discards `revoked` for the client's benefit and keeps it only for tests.
 */
export const gatewayGrantsRevoke = gatewayRoute(async (ctx, body) => {
  const token = stringField(body, "token");
  const clientId = stringField(body, "clientId");
  const tokenType = body.tokenType === "access" ? "access" : "refresh";
  if (token === null || clientId === null) return json({ revoked: false });

  const revoked = await ctx.runMutation(
    internal.functions.controlPlane.revokeGrantByToken,
    { hashedToken: await hashToken(token), tokenType, clientId },
  );
  return json({ revoked });
});

/* -------------------------------------------------------------------------- */
/* 10. POST /gateway/ingest/resolve — a recipient name to a personal context  */
/* -------------------------------------------------------------------------- */

/**
 * The one route a total stranger can drive, by sending mail.
 *
 * `{ "ingestion": null }` is the answer to every kind of no: no such name, a
 * reserved or malformed name, **the name is a shared context**, a personal
 * context that has since gained members, no policy row, unbound or unusable
 * storage, and over the rate limit. They are built here in one place so they
 * are byte-identical, because the difference between any two of them is a
 * username-enumeration oracle probeable from any mail client on earth.
 *
 * The ticket is minted here rather than in the mutation because hashing needs
 * the action runtime — the same reason `approveAuthorization` is an action. The
 * plaintext goes back to the worker and is never stored; only its digest is.
 */
export const gatewayIngestResolve = emailWorkerRoute(async (ctx, body) => {
  const name = stringField(body, "name");
  const sizeBytes = body.sizeBytes;
  // A malformed request is answered exactly like an unknown name. A 400 would
  // tell a caller holding the worker secret which part of its request was the
  // bad one, and there is nothing here a legitimate caller could act on.
  if (name === null || typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes)) {
    return json({ ingestion: null });
  }

  // Minted before the lookup, so the work done is the same whether or not the
  // name resolves. Nothing is written unless the mutation decides to write it.
  const ticket = randomOpaqueToken(32);
  const resolution = await ctx.runMutation(
    internal.functions.ingestionGateway.resolveForIngestion,
    { name, hashedTicket: await hashToken(ticket), sizeBytes },
  );
  if (resolution === null) return json({ ingestion: null });

  return json({ ingestion: { ticket, ...resolution } });
});

/* -------------------------------------------------------------------------- */
/* 11. POST /gateway/ingest/binding — spend a ticket for a credential         */
/* -------------------------------------------------------------------------- */

/**
 * THE SECOND CREDENTIAL ROUTE. Read `functions/ingestionGateway.ts` and the
 * "THE INGEST ROUTES" note at the top of this file before changing it.
 *
 * The ticket is the only input and it is not a lookup key for a workspace — it
 * is matched against `ingestionTickets.by_hashed_ticket`, and the workspace is
 * read off the row the control plane wrote at mint time. There is no path in
 * which anything the caller sends selects a context.
 *
 * Presented, so it arrives verbatim and is hashed here, like every other
 * presented token in this file. Single-use: `spendIngestionTicket` stamps and
 * checks in one transaction, so two concurrent presentations cannot both win.
 */
export const gatewayIngestBinding = emailWorkerRoute(async (ctx, body) => {
  const ticket = stringField(body, "ticket");
  if (ticket === null) return json({ binding: null });

  const binding = await ctx.runAction(
    internal.functions.ingestionGateway.openIngestionBinding,
    { hashedTicket: await hashToken(ticket) },
  );
  return json({ binding });
});

/* -------------------------------------------------------------------------- */
/* 12. POST /gateway/ingest/record — accounting, after the note is written    */
/* -------------------------------------------------------------------------- */

/**
 * Always `{ "ok": true }`.
 *
 * The note is already written by the time the worker calls this, so there is
 * nothing it could usefully do with a failure — and the worker swallows the
 * result anyway, because turning a bookkeeping error into an SMTP refusal would
 * tell the sender their message failed when it did not. Saying `true`
 * unconditionally also means a spent, expired, or invented ticket looks like a
 * good one from outside, which keeps this route from becoming a way to test
 * whether a ticket was real.
 */
export const gatewayIngestRecord = emailWorkerRoute(async (ctx, body) => {
  const ticket = stringField(body, "ticket");
  const outcome = body.outcome === "duplicate" ? "duplicate" : "captured";
  const bytes = typeof body.bytes === "number" && Number.isFinite(body.bytes) ? body.bytes : 0;
  if (ticket === null) return json({ ok: true });

  await ctx.runMutation(internal.functions.ingestionGateway.recordIngestion, {
    hashedTicket: await hashToken(ticket),
    outcome,
    bytes,
  });
  return json({ ok: true });
});

/* -------------------------------------------------------------------------- */

// POST only, every one of them. The contract has no GET shape, and a GET would
// put a token in a URL — in a log, in a referrer, in browser history.
http.route({ path: "/gateway/session", method: "POST", handler: gatewaySession });
http.route({ path: "/gateway/binding", method: "POST", handler: gatewayBinding });
http.route({
  path: "/gateway/clients/register",
  method: "POST",
  handler: gatewayClientsRegister,
});
http.route({
  path: "/gateway/clients/get",
  method: "POST",
  handler: gatewayClientsGet,
});
http.route({
  path: "/gateway/authorize/start",
  method: "POST",
  handler: gatewayAuthorizeStart,
});
http.route({
  path: "/gateway/codes/consume",
  method: "POST",
  handler: gatewayCodesConsume,
});
http.route({
  path: "/gateway/grants/create",
  method: "POST",
  handler: gatewayGrantsCreate,
});
http.route({
  path: "/gateway/grants/rotate",
  method: "POST",
  handler: gatewayGrantsRotate,
});
http.route({
  path: "/gateway/grants/revoke",
  method: "POST",
  handler: gatewayGrantsRevoke,
});
http.route({
  path: "/gateway/ingest/resolve",
  method: "POST",
  handler: gatewayIngestResolve,
});
http.route({
  path: "/gateway/ingest/binding",
  method: "POST",
  handler: gatewayIngestBinding,
});
http.route({
  path: "/gateway/ingest/record",
  method: "POST",
  handler: gatewayIngestRecord,
});

export default http;
