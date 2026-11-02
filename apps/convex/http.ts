/**
 * HTTP routes.
 *
 * Three families live here: the auth framework's own callbacks, the ten
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
 *    `/gateway/usage` is the one route whose *request* names several
 *    workspaces, and it is not an exception to this: it returns a count of
 *    rows written and nothing else. Naming a context there cannot read it,
 *    confirm it exists, or distinguish a real id from an invented one — every
 *    input is answered identically.
 *
 * The handlers behind these routes are in `functions/lib/gatewayRoutes/`,
 * grouped by what they answer. Each route is still declared here, built by
 * its factory, and registered at the bottom of this file.
 *
 * `__tests__/structure.test.ts` reads this file and enforces (1) structurally,
 * along with the rule that only an enumerated route may reach a decrypted
 * storage credential.
 *
 * The ingest routes, and why they relax the two-proof rule, are explained at
 * the top of `functions/ingestionGateway.ts`.
 */

import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { api, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { hashToken } from "./functions/lib/crypto";
import { logIngest } from "./functions/lib/ingestLog";
import {
  badRequest,
  json,
  randomOpaqueToken,
  MAX_PRIVACY_REQUEST_BYTES,
  readJsonBody,
  requestIsFromAgentWorker,
  requestIsFromEmailWorker,
  requestIsFromGateway,
  stringField,
  unauthorized,
} from "./functions/lib/gatewayAuth";
import { STRIPE_WEBHOOK_SECRET_ENV_VAR } from "./functions/lib/premium";
import {
  STRIPE_SIGNATURE_HEADER,
  stripeEventFacts,
  stripeSignatureIsValid,
} from "./functions/lib/stripe";
import * as sessions from "./functions/lib/gatewayRoutes/sessions";
import * as connections from "./functions/lib/gatewayRoutes/connections";
import * as noteMail from "./functions/lib/gatewayRoutes/noteMail";
import * as credentials from "./functions/lib/gatewayRoutes/credentials";
import * as privacyRoute from "./functions/lib/gatewayRoutes/privacy";
import * as signals from "./functions/lib/gatewayRoutes/signals";
import { gatewayTreeManifestHandler } from "./functions/lib/nodes/gatewayManifest";
import { gatewayTreeFactsHandler } from "./functions/lib/nodes/gatewayFacts";
import { gatewayNoteIdsAdoptHandler, gatewayNoteIdsLookupHandler, gatewayNoteIdsRemovedHandler, gatewayNoteIdsResolveHandler, gatewayNoteIdsWroteHandler } from "./functions/lib/noteIds/http";
import { ingestNoteIdsAdoptHandler, ingestNoteIdsLookupHandler, ingestNoteIdsWroteHandler } from "./functions/lib/noteIds/ingestHttp";
import { servedNoteCount } from "./functions/lib/nodes/servedCount";
import * as moveRoutes from "./functions/lib/gatewayRoutes/moves";
import { gatewayMoveAcrossHandler } from "./functions/lib/gatewayRoutes/moveAcross";
import * as jobs from "./functions/lib/gatewayRoutes/jobs";
import * as oauth from "./functions/lib/gatewayRoutes/oauth";
import * as links from "./functions/lib/gatewayRoutes/links";
import * as vault from "./functions/lib/gatewayRoutes/vault";
import * as personEmail from "./functions/lib/gatewayRoutes/personEmail";
import * as personMail from "./functions/lib/gatewayRoutes/personMail";
import * as personCalendar from "./functions/lib/gatewayRoutes/personCalendar";
import * as calendarWrite from "./functions/lib/gatewayRoutes/calendarWrite";
import * as googleChat from "./functions/lib/gatewayRoutes/googleChat";
import * as googleChatRead from "./functions/lib/gatewayRoutes/googleChatRead";
import * as site from "./functions/lib/gatewayRoutes/site";
import { gatewayPageCoverHandler, MAX_COVER_REQUEST_BYTES } from "./functions/lib/gatewayRoutes/pageCover";
import * as workspaceRoutes from "./functions/lib/gatewayRoutes/workspaces";
import * as feedback from "./functions/lib/gatewayRoutes/feedback";
import * as texReview from "./functions/lib/gatewayRoutes/texReview";
import * as agentTexts from "./functions/lib/gatewayRoutes/agentTexts";
import * as agentTextGroups from "./functions/lib/gatewayRoutes/agentTextGroups";
import * as textDecide from "./functions/lib/gatewayRoutes/textDecide";
import * as texStyleRoutes from "./functions/lib/gatewayRoutes/texStyle";
import * as texReviewSharing from "./functions/lib/gatewayRoutes/texReviewSharing";
import * as noteCard from "./functions/lib/gatewayRoutes/noteCard";
import * as builtinModel from "./functions/lib/gatewayRoutes/builtinModel";
import * as meetingSummary from "./functions/lib/gatewayRoutes/meetingSummary";
import * as agentTurns from "./functions/lib/gatewayRoutes/agentTurns";
import * as searchTiming from "./functions/lib/gatewayRoutes/searchTiming";
import * as routines from "./functions/lib/gatewayRoutes/routines";
import * as dreams from "./functions/lib/gatewayRoutes/dreams";
import * as texIdentity from "./functions/lib/gatewayRoutes/texIdentity";
import { gatewayTranscriptionConsentHandler } from "./functions/lib/gatewayRoutes/transcriptionConsent";
import * as heartbeats from "./functions/lib/gatewayRoutes/heartbeats";
import * as housekeeping from "./functions/lib/gatewayRoutes/housekeeping";
import * as mailHealth from "./functions/lib/gatewayRoutes/mailHealth";
import { serverError } from "./functions/lib/gatewayRoutes/responses";
import * as sharePreviews from "./functions/lib/publicRoutes/sharePreviews";
import * as shortLinkCards from "./functions/lib/publicRoutes/shortLinkCards";
import * as siteCards from "./functions/lib/publicRoutes/siteCards";
import * as siteHomeRoute from "./functions/lib/publicRoutes/siteHome";
import * as sitePageRoute from "./functions/lib/publicRoutes/sitePage";
import {
  calendarChannelRoute,
  calendarPushHandler,
  pubsubPushHandler,
  pubsubPushRoute,
} from "./functions/lib/googlePush/routes";
import { ingestEncryptionSiblings } from "./functions/lib/managedEncryptionFns/storeOption";
import { addAuthHttpRoutes, withSecurityHeaders } from "./functions/lib/httpSecurityHeaders";

const http = httpRouter();

// Auth routes (OTP callbacks, the JWKS and OpenID discovery), with the security headers.
addAuthHttpRoutes(http, auth.addHttpRoutes);

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
  handler: (ctx: ActionCtx, body: Record<string, unknown>) => Promise<Response>,
  maxBytes?: number,
) {
  return httpAction(async (ctx, request) => {
    if (!(await requestIsFromGateway(request))) return withSecurityHeaders(unauthorized());
    const body = await readJsonBody(request, maxBytes);
    return withSecurityHeaders(body === null ? badRequest() : await handler(ctx, body));
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
 *
 * ## Why this one logs and `gatewayRoute` does not
 *
 * A Worker whose `EMAIL_WORKER_SECRET` does not match this deployment's is
 * answered 401, throws `ControlPlaneError("status 401")` in
 * `infra/email-worker/src/controlPlane.ts`, is rethrown by `index.ts`, and
 * surfaces to the operator as Cloudflare's "worker script threw an exception" —
 * with nothing on either side naming the cause. That has happened, and it is
 * what cost hours: the two halves of this secret are set from two different
 * places (a GitHub secret for the Worker, `convex env set` for this
 * deployment), and no check anywhere compares them.
 *
 * The response is untouched — same status, same headers, same bytes, no detail
 * for the caller. The line goes to the deployment's own log, which only an
 * operator can read. See `functions/lib/ingestLog.ts`.
 */
function emailWorkerRoute(
  handler: (ctx: ActionCtx, body: Record<string, unknown>) => Promise<Response>,
) {
  return httpAction(async (ctx, request) => {
    if (!(await requestIsFromEmailWorker(request))) {
      logIngest({ event: "unauthorized" });
      return unauthorized();
    }
    const body = await readJsonBody(request);
    if (body === null) {
      logIngest({ event: "bad_request", reason: "body_not_a_json_object" });
      return badRequest();
    }
    return await handler(ctx, body);
  });
}

/**
 * The same wrapper again, for the texting assistant's own secret. A fourth
 * door for a third bearer secret: it can mint a short-lived grant for whoever
 * linked a phone, so it shares a key with neither caller above. See
 * `AGENT_WORKER_SECRET_ENV_VAR` in `functions/lib/gatewayAuth.ts`.
 */
function agentWorkerRoute(
  handler: (ctx: ActionCtx, body: Record<string, unknown>) => Promise<Response>,
) {
  return httpAction(async (ctx, request) => {
    if (!(await requestIsFromAgentWorker(request))) return unauthorized();
    const body = await readJsonBody(request);
    if (body === null) return badRequest();
    return await handler(ctx, body);
  });
}

/**
 * The third door, and the only one whose key is a signature rather than a
 * bearer secret.
 *
 * Stripe posts to this endpoint from an address nobody here controls, with no
 * Authorization header, because that is how webhooks work — so the two
 * factories above cannot be reused and this is not a shortcut around them. What
 * replaces the bearer check is strictly more than one: the body carries an
 * HMAC-SHA256 over `<timestamp>.<raw body>`, computed with a secret only Stripe
 * and this deployment hold, and the timestamp is both *inside* the MAC and
 * checked against the clock, so a captured delivery is not a standing key.
 *
 * `STRIPE_WEBHOOK_SECRET` is an environment variable and not an `appSecrets`
 * row, deliberately: this check has to happen before anything in the request is
 * trusted, and reading it out of the database would make this route the fourth
 * HTTP route able to reach a decrypted credential — a list
 * `__tests__/structure.test.ts` pins at three, each argued for. Same reasoning
 * `RESERVED_SECRET_NAMES` gives about `GATEWAY_SECRET`, and it is in that
 * refusal list for the same reason.
 *
 * **A deployment with no signing secret refuses every delivery.** Not "allows",
 * which would be a free upgrade for anybody who can find this URL, and is
 * exactly the shape of mistake that ships because it makes a staging
 * environment work.
 *
 * The raw body is read once, verified, and only then parsed. Re-serialising a
 * parsed object and hashing that verifies a different document from the one
 * Stripe signed.
 */
function stripeWebhookRoute(
  handler: (ctx: ActionCtx, body: unknown) => Promise<Response>,
) {
  return httpAction(async (ctx, request) => {
    const payload = await request.text();
    const signed = await stripeSignatureIsValid({
      payload,
      header: request.headers.get(STRIPE_SIGNATURE_HEADER),
      secret: process.env[STRIPE_WEBHOOK_SECRET_ENV_VAR],
    });
    if (!signed) return unauthorized();
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return badRequest();
    }
    return await handler(ctx, body);
  });
}

/* -------------------------------------------------------------------------- */
/* 1. POST /gateway/session — resolve an access token to a session            */
/* -------------------------------------------------------------------------- */

export const gatewaySession = gatewayRoute(sessions.gatewaySessionHandler);
export const gatewayToolsListed = gatewayRoute(sessions.gatewayToolsListedHandler);
export const gatewayMailJoin = gatewayRoute(noteMail.gatewayMailJoinHandler);
export const gatewayMailGet = gatewayRoute(noteMail.gatewayMailGetHandler);
export const gatewayMailRead = gatewayRoute(noteMail.gatewayMailReadHandler);

/* -------------------------------------------------------------------------- */
/* 1b. POST /gateway/sessions/by-grant — resolve live relay grant metadata    */
/* -------------------------------------------------------------------------- */

export const gatewaySessionsByGrant = gatewayRoute(
  sessions.gatewaySessionsByGrantHandler,
);

/* -------------------------------------------------------------------------- */
/* 2. POST /gateway/binding — fetch a workspace's storage binding            */
/* -------------------------------------------------------------------------- */

export const gatewayBinding = gatewayRoute(credentials.gatewayBindingHandler);
export const gatewayPrivacy = gatewayRoute(privacyRoute.gatewayPrivacyHandler, MAX_PRIVACY_REQUEST_BYTES);

/** The built-in model's gate and meter: the only model the assistant runs on. */
export const gatewayBuiltinModel = gatewayRoute(builtinModel.gatewayBuiltinModelHandler);
export const gatewayBuiltinUsage = gatewayRoute(builtinModel.gatewayBuiltinUsageHandler);
/** Meeting summaries' gate and meter, for any live grant. */
export const gatewayMeetingSummary = gatewayRoute(meetingSummary.gatewayMeetingSummaryHandler);
export const gatewayMeetingSummaryUsage = gatewayRoute(meetingSummary.gatewayMeetingSummaryUsageHandler);
export const gatewayAgentTurn = gatewayRoute(agentTurns.gatewayAgentTurnHandler);

/* -------------------------------------------------------------------------- */
/* 2b. POST /gateway/search-index/progress — the backfill reporting in        */
/* -------------------------------------------------------------------------- */

export const gatewaySearchIndexProgress = gatewayRoute(
  signals.gatewaySearchIndexProgressHandler,
);

/* -------------------------------------------------------------------------- */
/* 2b-bis. POST /gateway/activity — a context changed                        */
/* -------------------------------------------------------------------------- */

export const gatewayActivity = gatewayRoute(signals.gatewayActivityHandler);

/* 2b-quater. POST /gateway/moves — an AI client moved a note between contexts */
export const gatewayMoves = gatewayRoute(signals.gatewayMovesHandler);

/* 2b-quinquies. POST /gateway/moves/start — an AI client's folder move, queued */
export const gatewayMoveStart = gatewayRoute(moveRoutes.gatewayMoveStartHandler);

/* -------------------------------------------------------------------------- */
/* 2b-tree. POST /gateway/tree — a context's file tree changed               */
/* -------------------------------------------------------------------------- */

export const gatewayTree = gatewayRoute(signals.gatewayTreeHandler);
export const gatewayPageCover = gatewayRoute(gatewayPageCoverHandler, MAX_COVER_REQUEST_BYTES); // a page's cover, for its link's card
export const gatewayTreeTouch = gatewayRoute(signals.gatewayTreeTouchHandler);
export const gatewayTreeManifest = gatewayRoute(gatewayTreeManifestHandler);
export const gatewayTreeFacts = gatewayRoute(gatewayTreeFactsHandler);
/* -------------------------------------------------------------------------- */
/* 2b-noteids. POST /gateway/note-ids/lookup and /wrote — the id copy         */
/* -------------------------------------------------------------------------- */

export const gatewayNoteIdsLookup = gatewayRoute(gatewayNoteIdsLookupHandler);
export const gatewayNoteIdsWrote = gatewayRoute(gatewayNoteIdsWroteHandler);
export const gatewayNoteIdsResolve = gatewayRoute(gatewayNoteIdsResolveHandler);

/* -------------------------------------------------------------------------- */
/* 2b-ter. POST /gateway/website — a write of ours moved the site's bytes   */
/* -------------------------------------------------------------------------- */

export const gatewayWebsite = gatewayRoute(signals.gatewayWebsiteHandler);

/* POST /gateway/routines — a write touched a routine root; re-read both. */
export const gatewayRoutines = gatewayRoute(routines.gatewayRoutinesHandler);

/* -------------------------------------------------------------------------- */
/* 2b-bis. POST /gateway/forms/notify — a form took an answer                */
/* -------------------------------------------------------------------------- */

export const gatewayFormsNotify = gatewayRoute(
  signals.gatewayFormsNotifyHandler,
);

/* -------------------------------------------------------------------------- */
/* 2c. POST /gateway/jobs/create — mint queued gateway work                  */
/* -------------------------------------------------------------------------- */

export const gatewayJobsCreate = gatewayRoute(jobs.gatewayJobsCreateHandler);

/* -------------------------------------------------------------------------- */
/* 2d. POST /gateway/jobs/open — spend queued work for one bounded attempt    */
/* -------------------------------------------------------------------------- */

export const gatewayJobsOpen = gatewayRoute(jobs.gatewayJobsOpenHandler);

/* -------------------------------------------------------------------------- */
/* 2e. POST /gateway/jobs/report — report a queue attempt outcome             */
/* -------------------------------------------------------------------------- */

export const gatewayJobsReport = gatewayRoute(jobs.gatewayJobsReportHandler);

/* 2f. POST /gateway/mover/open, /gateway/tex-store/open — the control plane's tickets */
export const gatewayMoverOpen = gatewayRoute(jobs.gatewayMoverOpenHandler);
export const gatewayTexStoreOpen = gatewayRoute(jobs.gatewayTexStoreOpenHandler);

/* -------------------------------------------------------------------------- */
/* 3. POST /gateway/clients/register — RFC 7591 dynamic client registration  */
/* -------------------------------------------------------------------------- */

export const gatewayClientsRegister = gatewayRoute(
  oauth.gatewayClientsRegisterHandler,
);

/* -------------------------------------------------------------------------- */
/* 4. POST /gateway/clients/get — look up a registered client                */
/* -------------------------------------------------------------------------- */

export const gatewayClientsGet = gatewayRoute(oauth.gatewayClientsGetHandler);

/* -------------------------------------------------------------------------- */
/* 5. POST /gateway/authorize/start — park a validated authorization request */
/* -------------------------------------------------------------------------- */

export const gatewayAuthorizeStart = gatewayRoute(
  oauth.gatewayAuthorizeStartHandler,
);

/* -------------------------------------------------------------------------- */
/* 6. POST /gateway/codes/consume — atomically spend an authorization code   */
/* -------------------------------------------------------------------------- */

export const gatewayCodesConsume = gatewayRoute(
  oauth.gatewayCodesConsumeHandler,
);

/* -------------------------------------------------------------------------- */
/* 7. POST /gateway/grants/create — a grant at the end of a token exchange   */
/* -------------------------------------------------------------------------- */

export const gatewayGrantsCreate = gatewayRoute(
  oauth.gatewayGrantsCreateHandler,
);

/* -------------------------------------------------------------------------- */
/* 8. POST /gateway/grants/rotate — refresh, with mandatory rotation         */
/* -------------------------------------------------------------------------- */

export const gatewayGrantsRotate = gatewayRoute(
  oauth.gatewayGrantsRotateHandler,
);

/* -------------------------------------------------------------------------- */
/* 9. POST /gateway/grants/revoke — RFC 7009                                 */
/* -------------------------------------------------------------------------- */

export const gatewayGrantsRevoke = gatewayRoute(
  oauth.gatewayGrantsRevokeHandler,
);

/* -------------------------------------------------------------------------- */
/* 10. POST /gateway/ingest/resolve — a recipient name to a personal context  */
/* -------------------------------------------------------------------------- */

/**
 * The one route a total stranger can drive, by sending mail.
 *
 * `{ "ingestion": null }` is the answer to every kind of no: no such name, a
 * reserved or malformed name, **the name is a shared context**, a personal
 * context with no resolvable owner, no policy row, unbound or unusable
 * storage, and over the rate limit. They are built here in one place so they
 * are byte-identical, because the difference between any two of them is a
 * username-enumeration oracle probeable from any mail client on earth.
 *
 * The ticket is minted here rather than in the mutation because hashing needs
 * the action runtime — the same reason `approveAuthorization` is an action. The
 * plaintext goes back to the worker and is never stored; only its digest is.
 */
export const gatewayIngestResolve = emailWorkerRoute(async (ctx, body) => {
  // `username` is the worker's word for the local part of the address a sender
  // wrote. It is a name in the one global namespace usernames and context slugs
  // share, and it resolves only if it belongs to a personal context — see
  // `resolvePersonalContextForIngestion`.
  const username = stringField(body, "username");
  const sizeBytes = body.sizeBytes;
  // A malformed request is answered exactly like an unknown name. A 400 would
  // tell a caller holding the worker secret which part of its request was the
  // bad one, and there is nothing here a legitimate caller could act on.
  //
  // It is, however, recorded — because "the caller sent the wrong field name"
  // and "that name does not resolve" being one answer is exactly what makes
  // this route impossible to debug from outside. An operator probing with
  // `{"name": …}` instead of `{"username": …}` gets a perfectly ordinary
  // `{"ingestion":null}` that never touches the database, and reads it as
  // evidence about their data. That happened. The reason is operator-only; the
  // response is unchanged. See `functions/lib/ingestLog.ts`.
  if (
    username === null ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes)
  ) {
    logIngest({
      event: "resolve_refused",
      reason: username === null ? "missing_username" : "missing_size_bytes",
    });
    return json({ ingestion: null });
  }

  // `envelopeFrom` is sent and deliberately not read. The contract offers it
  // "for rate limiting only; NOT authority", and it is attacker-chosen, so
  // limiting on it protects nothing — the limit below is keyed on the
  // recipient, which is the thing being probed. Reading it here would also put
  // a stranger's address one refactor away from a log line.
  //
  // Minted before the lookup, so the work done is the same whether or not the
  // name resolves. Nothing is written unless the mutation decides to write it.
  const ticket = randomOpaqueToken(32);
  const resolution = await ctx.runMutation(
    internal.functions.ingestionGateway.resolveForIngestion,
    { name: username, hashedTicket: await hashToken(ticket), sizeBytes },
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
  if (binding === null) return json({ binding });
  // The free managed tier's note cap, a sibling as on `/gateway/binding`, for
  // the workspace read off the ticket's own row — never anything the caller
  // sent. Absent for every other context, and absent on a failed read: a
  // billing lookup must not cost somebody their mail.
  const noteCap = await ctx
    .runQuery(internal.functions.billing.noteCap, {
      workspaceId: binding.workspaceId,
    })
    .catch(() => null);
  // What the cap counts, from the Convex tree's rows and never the bucket
  // (`lib/nodes/servedCount.ts`); asked only when there is a cap. Absent when
  // the tree cannot say, and the worker then admits the note.
  const counted = noteCap === null ? null : await servedNoteCount(ctx, binding.workspaceId);
  const managed = await ingestEncryptionSiblings(ctx, binding.workspaceId);
  if (managed === null) return json({ binding: null });
  return json({
    binding,
    ...(noteCap === null ? {} : { noteCap }),
    ...(counted === null ? {} : { noteCount: counted.notes }),
    // Every workspace is keyed (2026-10-22): the email worker writes each note to its id key.
    keyed: true,
    ...managed,
  });
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
  const bytes =
    typeof body.bytes === "number" && Number.isFinite(body.bytes)
      ? body.bytes
      : 0;
  if (ticket === null) return json({ ok: true });

  await ctx.runMutation(internal.functions.ingestionGateway.recordIngestion, {
    hashedTicket: await hashToken(ticket),
    outcome,
    bytes,
  });
  return json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/* The share link preview — the one route here with no secret at all           */
/* -------------------------------------------------------------------------- */

// The title a share unfurls with. Handler: functions/lib/publicRoutes/sharePreviews.ts.
export const sharePreview = httpAction(sharePreviews.sharePreviewHandler);

http.route({ path: "/share/preview", method: "POST", handler: sharePreview });

// The card image for a share. Handler: functions/lib/publicRoutes/sharePreviews.ts.
export const shareCard = httpAction(sharePreviews.shareCardHandler);

http.route({ path: "/share/card", method: "POST", handler: shareCard });

// The card for a readable team link. Handler: functions/lib/publicRoutes/sharePreviews.ts.
export const shareNotePreview = httpAction(sharePreviews.shareNotePreviewHandler);

http.route({ path: "/share/note", method: "POST", handler: shareNotePreview });

/**
 * `POST /share/short` — the card for a short link, `/@seyi/intake`. Why this
 * unauthenticated route may answer at all is argued above its handler.
 */
export const shareShortLinkPreview = httpAction(
  shortLinkCards.shareShortLinkPreviewHandler,
);

http.route({ path: "/share/short", method: "POST", handler: shareShortLinkPreview });

/* -------------------------------------------------------------------------- */
/* POST /share/short/card — the card image for a short link                    */
/* -------------------------------------------------------------------------- */

/**
 * The picture behind `/og/n/@handle/slug.png`.
 *
 * Short links had no image, and the reason was right: a card was addressable
 * only by the share's **token**, a slug is a word anybody can type, and a
 * preview route that answered a guessed word with a 64-character secret
 * publishes the secret.
 *
 * What was wrong was the conclusion. The image does not have to be addressed by
 * the token — it can be addressed by the handle and slug the crawler already
 * used to ask for the title. The token stays where it was, nothing new is
 * disclosed (the picture says the note's name, which `/share/short` already
 * answers with), and a link somebody reads off a card unfurls like every other
 * link this product mints.
 *
 * Its argument is guessable, like `/share/note`'s and unlike the two token
 * routes', so it is bounded the same way: it answers only for a slug the owner
 * deliberately claimed on an `anyone` link, and a slug nobody claimed is
 * byte-identical to one that does not exist.
 */
export const shareShortLinkCard = httpAction(
  shortLinkCards.shareShortLinkCardHandler,
);

http.route({ path: "/share/short/card", method: "POST", handler: shareShortLinkCard });

/* -------------------------------------------------------------------------- */
/* POST /site/preview, /site/card — a website page's unfurl and its picture    */
/* -------------------------------------------------------------------------- */

/**
 * A published page unfurls as itself. Both take a handle and a route path and
 * resolve the page as an anonymous visitor: they answer only for a live public
 * page of a site its owner turned on, which is what that address already shows
 * to anyone who opens it. See `lib/websites/preview.ts` and the "unfurls as
 * itself" section of `docs/decisions/websites.md`.
 */
export const sitePreview = httpAction(siteCards.sitePreviewHandler);
http.route({ path: "/site/preview", method: "POST", handler: sitePreview });

export const siteCard = httpAction(siteCards.siteCardHandler);
http.route({ path: "/site/card", method: "POST", handler: siteCard });

/** The homepage's whole site, for the router to put in its HTML. `siteHome.ts`. */
export const siteHome = httpAction(siteHomeRoute.siteHomeHandler);
http.route({ path: "/site/home", method: "POST", handler: siteHome });

/**
 * The homepage site's revision alone: one database read, asked on every visit
 * so the router can serve the copy it keeps until the next Publish.
 */
export const siteHomeRevision = httpAction(siteHomeRoute.siteHomeRevisionHandler);
http.route({ path: "/site/home/revision", method: "POST", handler: siteHomeRevision });

/** Any site's revision, and an address as anyone sees it, kept per revision by the router. `sitePage.ts`. */
export const siteRevisionRoute = httpAction(sitePageRoute.siteRevisionRouteHandler);
http.route({ path: "/site/revision", method: "POST", handler: siteRevisionRoute });
export const sitePage = httpAction(sitePageRoute.sitePageHandler);
http.route({ path: "/site/page", method: "POST", handler: sitePage });

/* -------------------------------------------------------------------------- */
/* POST /domain/resolve — which workspace a customer domain serves             */
/* -------------------------------------------------------------------------- */

/**
 * The router's question for a request that arrived at a customer's domain.
 *
 * Always 200, always `{ "handle": string | null, "homeSlug": string | null }`,
 * plus `"redirect": "<root>"` for a root domain's live `www.`, which serves
 * nothing of its own. Unknown, pending, suspended and removed domains are all
 * the null shape, so
 * the router fails closed on every one of them the same way. It discloses what
 * the domain itself publishes and nothing else. POST, like the share routes,
 * so a hostname does not land in an outbound URL.
 */
export const domainResolve = httpAction(async (ctx, request) => {
  const body = await readJsonBody(request);
  const hostname = body === null ? null : stringField(body, "hostname");
  if (hostname === null) return json({ handle: null, homeSlug: null });
  const result = await ctx.runQuery(api.functions.customDomains.resolveHost, {
    hostname,
  });
  if (result !== null && "redirect" in result) {
    return json({ handle: null, homeSlug: null, redirect: result.redirect });
  }
  return json({
    handle: result?.handle ?? null,
    homeSlug: result?.homeSlug ?? null,
  });
});

http.route({ path: "/domain/resolve", method: "POST", handler: domainResolve });

/* -------------------------------------------------------------------------- */
/* POST /stripe/webhook — a signed subscription event                          */
/* -------------------------------------------------------------------------- */

/**
 * What Stripe tells us about a subscription.
 *
 * The signature is checked by the factory; everything here runs on a body that
 * has been proved to come from Stripe. What is left is deliberately thin: read
 * the handful of fields `stripeEventFacts` names and hand them to one internal
 * mutation, which decides which context the event is about and whether it is
 * still news.
 *
 * **It answers 200 to everything it understood, including work it chose not to
 * do.** A type nobody handles, an event for a context that no longer exists, a
 * redelivery of an event already applied — all 200, because a non-2xx tells
 * Stripe to retry, and retrying will not change any of those answers. A 4xx is
 * reserved for a body that is not an event at all, and a 5xx for our own
 * failure, which is the one case a retry can fix.
 *
 * The response body says nothing about which context, which subscription, or
 * whether anything changed. The caller is Stripe and does not need it, and this
 * endpoint is reachable by anybody who can construct a signed request — which
 * during a secret leak is more people than we would like.
 */
export const stripeWebhook = stripeWebhookRoute(async (ctx, body) => {
  const facts = stripeEventFacts(body);
  if (facts === null) return badRequest();
  try {
    await ctx.runMutation(internal.functions.billing.applyStripeEvent, {
      id: facts.id,
      type: facts.type,
      createdSeconds: facts.createdSeconds,
      customerId: facts.customerId,
      subscriptionId: facts.subscriptionId,
      checkoutRef: facts.checkoutRef,
      rawStatus: facts.rawStatus,
      sessionStatus: facts.sessionStatus,
      paymentStatus: facts.paymentStatus,
      currentPeriodEndSeconds: facts.currentPeriodEndSeconds,
      cancelAtPeriodEnd: facts.cancelAtPeriodEnd,
    });
  } catch {
    // Ours, so Stripe should retry. Nothing about the failure goes back.
    return serverError();
  }
  return json({ received: true });
});

http.route({ path: "/stripe/webhook", method: "POST", handler: stripeWebhook });

/** Google's push notifications: each only makes a sync due sooner. `lib/googlePush/routes.ts`. */
export const googlePubsubPush = pubsubPushRoute(pubsubPushHandler);
http.route({ path: "/google/push/pubsub", method: "POST", handler: googlePubsubPush });
export const googleCalendarPush = calendarChannelRoute(calendarPushHandler);
http.route({ path: "/google/push/calendar", method: "POST", handler: googleCalendarPush });

export const gatewayUsage = gatewayRoute(signals.gatewayUsageHandler);
export const gatewaySearchTiming = gatewayRoute(searchTiming.gatewaySearchTimingHandler);

/* -------------------------------------------------------------------------- */

// POST only, every one of them. The contract has no GET shape, and a GET would
// put a token in a URL — in a log, in a referrer, in browser history.
http.route({ path: "/gateway/session", method: "POST", handler: gatewaySession });
http.route({ path: "/gateway/sessions/by-grant", method: "POST", handler: gatewaySessionsByGrant });
http.route({ path: "/gateway/binding", method: "POST", handler: gatewayBinding });
http.route({ path: "/gateway/privacy", method: "POST", handler: gatewayPrivacy });
http.route({ path: "/gateway/builtin-model", method: "POST", handler: gatewayBuiltinModel });
http.route({ path: "/gateway/builtin-model/usage", method: "POST", handler: gatewayBuiltinUsage });
http.route({ path: "/gateway/meeting-summary", method: "POST", handler: gatewayMeetingSummary });
http.route({ path: "/gateway/meeting-summary/usage", method: "POST", handler: gatewayMeetingSummaryUsage });
http.route({ path: "/gateway/agent-turn", method: "POST", handler: gatewayAgentTurn });
http.route({ path: "/gateway/search-index/progress", method: "POST", handler: gatewaySearchIndexProgress });
http.route({ path: "/gateway/activity", method: "POST", handler: gatewayActivity });
http.route({ path: "/gateway/moves", method: "POST", handler: gatewayMoves });
http.route({ path: "/gateway/moves/start", method: "POST", handler: gatewayMoveStart });
http.route({ path: "/gateway/moves/batch", method: "POST", handler: gatewayRoute(moveRoutes.gatewayMoveBatchHandler) });
http.route({ path: "/gateway/moves/across", method: "POST", handler: gatewayRoute(gatewayMoveAcrossHandler) });
http.route({ path: "/gateway/tree", method: "POST", handler: gatewayTree });
http.route({ path: "/gateway/tree/touch", method: "POST", handler: gatewayTreeTouch });
http.route({ path: "/gateway/objects/behind", method: "POST", handler: gatewayRoute(signals.gatewayObjectBehindHandler) });
http.route({ path: "/gateway/tree/manifest", method: "POST", handler: gatewayTreeManifest });
http.route({ path: "/gateway/tree/facts", method: "POST", handler: gatewayTreeFacts });
http.route({ path: "/gateway/page-cover", method: "POST", handler: gatewayPageCover });
http.route({ path: "/gateway/note-ids/lookup", method: "POST", handler: gatewayNoteIdsLookup });
http.route({ path: "/gateway/note-ids/wrote", method: "POST", handler: gatewayNoteIdsWrote });
http.route({ path: "/gateway/note-ids/resolve", method: "POST", handler: gatewayNoteIdsResolve });
http.route({ path: "/gateway/note-ids/adopt", method: "POST", handler: gatewayRoute(gatewayNoteIdsAdoptHandler) });
http.route({ path: "/gateway/note-ids/removed", method: "POST", handler: gatewayRoute(gatewayNoteIdsRemovedHandler) });
http.route({ path: "/gateway/website", method: "POST", handler: gatewayWebsite });
http.route({ path: "/gateway/routines", method: "POST", handler: gatewayRoutines });
http.route({ path: "/gateway/forms/notify", method: "POST", handler: gatewayFormsNotify });
http.route({ path: "/gateway/jobs/create", method: "POST", handler: gatewayJobsCreate });
http.route({ path: "/gateway/jobs/open", method: "POST", handler: gatewayJobsOpen });
http.route({ path: "/gateway/jobs/report", method: "POST", handler: gatewayJobsReport });
http.route({ path: "/gateway/mover/open", method: "POST", handler: gatewayMoverOpen });
http.route({ path: "/gateway/tex-store/open", method: "POST", handler: gatewayTexStoreOpen });
http.route({ path: "/gateway/clients/register", method: "POST", handler: gatewayClientsRegister });
http.route({ path: "/gateway/clients/get", method: "POST", handler: gatewayClientsGet });
http.route({ path: "/gateway/authorize/start", method: "POST", handler: gatewayAuthorizeStart });
http.route({ path: "/gateway/codes/consume", method: "POST", handler: gatewayCodesConsume });
http.route({ path: "/gateway/grants/create", method: "POST", handler: gatewayGrantsCreate });
http.route({ path: "/gateway/grants/rotate", method: "POST", handler: gatewayGrantsRotate });
http.route({ path: "/gateway/grants/revoke", method: "POST", handler: gatewayGrantsRevoke });
http.route({ path: "/gateway/grants/tools-listed", method: "POST", handler: gatewayToolsListed });
http.route({ path: "/gateway/mail/join", method: "POST", handler: gatewayMailJoin });
http.route({ path: "/gateway/mail/get", method: "POST", handler: gatewayMailGet });
http.route({ path: "/gateway/mail/read", method: "POST", handler: gatewayMailRead });
http.route({ path: "/gateway/ingest/resolve", method: "POST", handler: gatewayIngestResolve });
http.route({ path: "/gateway/ingest/binding", method: "POST", handler: gatewayIngestBinding });
http.route({ path: "/gateway/ingest/record", method: "POST", handler: gatewayIngestRecord });
export const gatewayIngestNoteIdsLookup = emailWorkerRoute(ingestNoteIdsLookupHandler);
export const gatewayIngestNoteIdsWrote = emailWorkerRoute(ingestNoteIdsWroteHandler);
export const gatewayIngestNoteIdsAdopt = emailWorkerRoute(ingestNoteIdsAdoptHandler);
http.route({ path: "/gateway/ingest/note-ids/lookup", method: "POST", handler: gatewayIngestNoteIdsLookup });
http.route({ path: "/gateway/ingest/note-ids/wrote", method: "POST", handler: gatewayIngestNoteIdsWrote });
http.route({ path: "/gateway/ingest/note-ids/adopt", method: "POST", handler: gatewayIngestNoteIdsAdopt });
/* -------------------------------------------------------------------------- */
/* Links, for an agent that asked for one                                     */
/* -------------------------------------------------------------------------- */

export const gatewayLinksCreate = gatewayRoute(links.gatewayLinksCreateHandler);

http.route({ path: "/gateway/links/create", method: "POST", handler: gatewayLinksCreate });

// A page where the person saves or shares a vault login themselves.
export const gatewayVaultRequest = gatewayRoute(vault.gatewayVaultRequestHandler);

http.route({ path: "/gateway/vault/request", method: "POST", handler: gatewayVaultRequest });
http.route({ path: "/gateway/browser-profile", method: "POST", handler: gatewayRoute(vault.gatewayBrowserProfileHandler) });

// A connector: a link for the person to connect an app, and one call through it.
export const gatewayConnectRequest = gatewayRoute(connections.gatewayConnectRequestHandler);
export const gatewayConnectCall = gatewayRoute(connections.gatewayConnectCallHandler, 128_000);
export const gatewayConnectApps = gatewayRoute(connections.gatewayConnectAppsHandler);

http.route({ path: "/gateway/connect/request", method: "POST", handler: gatewayConnectRequest });
http.route({ path: "/gateway/connect/call", method: "POST", handler: gatewayConnectCall });
http.route({ path: "/gateway/connect/apps", method: "POST", handler: gatewayConnectApps });

// One email, as the token's person, after they said yes to its exact copy.
export const gatewayPersonEmail = gatewayRoute(personEmail.gatewayPersonEmailHandler, 128_000);

http.route({ path: "/gateway/email/send", method: "POST", handler: gatewayPersonEmail });

// One email saved as a draft in the token's person's Gmail; it reaches nobody.
export const gatewayPersonEmailDraft = gatewayRoute(personEmail.gatewayPersonEmailDraftHandler, 128_000);

http.route({ path: "/gateway/email/draft", method: "POST", handler: gatewayPersonEmailDraft });

// The person's own mail, read live for what their synced notes do not hold.
export const gatewayPersonMailSearch = gatewayRoute(personMail.gatewayPersonMailSearchHandler);
export const gatewayPersonMailRead = gatewayRoute(personMail.gatewayPersonMailReadHandler);

http.route({ path: "/gateway/email/search", method: "POST", handler: gatewayPersonMailSearch });
http.route({ path: "/gateway/email/read", method: "POST", handler: gatewayPersonMailRead });

// One calendar change, as the token's person, after they said yes to it.
export const gatewayCalendarWrite = gatewayRoute(calendarWrite.gatewayCalendarWriteHandler);

http.route({ path: "/gateway/calendar/event", method: "POST", handler: gatewayCalendarWrite });

// One Google Chat message, as the token's person, after they said yes to it; and their spaces, by name.
export const gatewayChatSend = gatewayRoute(googleChat.gatewayChatSendHandler);
export const gatewayChatSpaces = gatewayRoute(googleChat.gatewayChatSpacesHandler);

http.route({ path: "/gateway/chat/send", method: "POST", handler: gatewayChatSend });
http.route({ path: "/gateway/chat/spaces", method: "POST", handler: gatewayChatSpaces });

// The Chat messages written to the token's person lately, read live for Tex's check-ins.
export const gatewayChatRecent = gatewayRoute(googleChatRead.gatewayChatRecentHandler);

http.route({ path: "/gateway/chat/recent", method: "POST", handler: gatewayChatRecent });

// Days of the person's own calendars, read live: nothing of a calendar is copied into notes.
export const gatewayPersonCalendarDays = gatewayRoute(personCalendar.gatewayPersonCalendarDaysHandler);

http.route({ path: "/gateway/calendar/days", method: "POST", handler: gatewayPersonCalendarDays });

export const gatewayFeedback = gatewayRoute(feedback.gatewayFeedbackHandler);

http.route({ path: "/gateway/feedback", method: "POST", handler: gatewayFeedback });

// Tex's review of a finished conversation: scores for everyone, words only where everyone said yes.
http.route({ path: "/gateway/tex-review", method: "POST", handler: gatewayRoute(texReview.gatewayTexReviewHandler) });

export const gatewayLinksList = gatewayRoute(links.gatewayLinksListHandler);

http.route({ path: "/gateway/links/list", method: "POST", handler: gatewayLinksList });

export const gatewayLinksRevoke = gatewayRoute(links.gatewayLinksRevokeHandler);

http.route({ path: "/gateway/links/revoke", method: "POST", handler: gatewayLinksRevoke });

export const gatewayWorkspacesCreate = gatewayRoute(workspaceRoutes.gatewayWorkspacesCreateHandler); // setting a workspace up through an agent: create, lay out, connect Google
export const gatewayWorkspacesLayout = gatewayRoute(workspaceRoutes.gatewayWorkspacesLayoutHandler);
export const gatewayWorkspacesConnectGoogle = gatewayRoute(workspaceRoutes.gatewayWorkspacesConnectGoogleHandler);
export const gatewayWorkspacesInvite = gatewayRoute(workspaceRoutes.gatewayWorkspacesInviteHandler);
http.route({ path: "/gateway/workspaces/create", method: "POST", handler: gatewayWorkspacesCreate });
http.route({ path: "/gateway/workspaces/layout", method: "POST", handler: gatewayWorkspacesLayout });
http.route({ path: "/gateway/workspaces/connect-google", method: "POST", handler: gatewayWorkspacesConnectGoogle });
http.route({ path: "/gateway/workspaces/invite", method: "POST", handler: gatewayWorkspacesInvite });
http.route({ path: "/gateway/access/profiles", method: "POST", handler: gatewayRoute(workspaceRoutes.gatewayAccessProfilesHandler) }); // names for a workspace object's members (`functions/accessProfiles.ts`)
http.route({ path: "/gateway/access/mirror", method: "POST", handler: gatewayRoute(workspaceRoutes.gatewayAccessMirrorHandler) }); // Convex written behind an object's access write (`functions/accessMirror.ts`)
/* Tex's dream now, for the owner's own agent (`lib/dreams/now.ts`). */
export const gatewayDreamsStart = gatewayRoute(dreams.gatewayDreamsStartHandler);
http.route({ path: "/gateway/dreams/start", method: "POST", handler: gatewayDreamsStart });
http.route({ path: "/gateway/tex/command", method: "POST", handler: gatewayRoute(texStyleRoutes.gatewayTexCommandHandler) }); // the agent's chat commands, on its own grant (`functions/texCommands.ts`)
/* Who is texting Tex, for the turns Tex answers for one person (`lib/texIdentity/identity.ts`). */
export const gatewayAgentIdentity = gatewayRoute(texIdentity.gatewayAgentIdentityHandler);
http.route({ path: "/gateway/agent/identity", method: "POST", handler: gatewayAgentIdentity });
export const gatewayTranscriptionConsent = gatewayRoute(gatewayTranscriptionConsentHandler);
http.route({ path: "/gateway/transcription/consent", method: "POST", handler: gatewayTranscriptionConsent });
/* An agent asks for the person's attention (`lib/attention/ask.ts`); delivered by their check-in row. */
export const gatewayAttentionAsk = gatewayRoute(heartbeats.gatewayAttentionAskHandler);
http.route({ path: "/gateway/attention/ask", method: "POST", handler: gatewayAttentionAsk });
/* Whether the person's own mailboxes are working, for their agents (`lib/mailHealth/`). */
http.route({ path: "/gateway/mail-health", method: "POST", handler: gatewayRoute(mailHealth.gatewayMailHealthHandler) });
http.route({ path: "/gateway/mail-health/raised", method: "POST", handler: gatewayRoute(mailHealth.gatewayMailHealthRaisedHandler) });

/* A website's status or a publish, for an owner's or editor's agent. */
export const gatewaySite = gatewayRoute(site.gatewaySiteHandler);
http.route({ path: "/gateway/site", method: "POST", handler: gatewaySite });
http.route({ path: "/gateway/usage", method: "POST", handler: gatewayUsage });
http.route({ path: "/gateway/search-timing", method: "POST", handler: gatewaySearchTiming });

/* The texting assistant: link a phone, and open a session for one text. */
export const agentTextsLink = agentWorkerRoute(agentTexts.agentTextsLinkHandler);
export const agentTextsSession = agentWorkerRoute(agentTexts.agentTextsSessionHandler);
http.route({ path: "/agent-texts/link", method: "POST", handler: agentTextsLink });
http.route({ path: "/agent-texts/session", method: "POST", handler: agentTextsSession });
export const agentTextsInvite = agentWorkerRoute(agentTexts.agentTextsInviteHandler);
export const agentTextsUnlink = agentWorkerRoute(agentTexts.agentTextsUnlinkHandler);
http.route({ path: "/agent-texts/invite", method: "POST", handler: agentTextsInvite });
http.route({ path: "/agent-texts/unlink", method: "POST", handler: agentTextsUnlink });
/* A tagged message or a command in a group chat Tex is in (`functions/textGroups.ts`). */
export const agentTextsGroup = agentWorkerRoute(agentTextGroups.agentTextsGroupHandler);
http.route({ path: "/agent-texts/group", method: "POST", handler: agentTextsGroup });
/* Whether Tex answers, reacts or stays silent, and a group's chosen style (`docs/design/tex-event-log/CONTRACT.md`). */
http.route({ path: "/agent-texts/decide", method: "POST", handler: agentWorkerRoute(textDecide.agentTextsDecideHandler) });
http.route({ path: "/agent-texts/recheck", method: "POST", handler: agentWorkerRoute(textDecide.agentTextsRecheckHandler) }); // `textRecheck.ts`
http.route({ path: "/agent-texts/group/engagement", method: "POST", handler: agentWorkerRoute(textDecide.agentTextsGroupEngagementHandler) });
http.route({ path: "/agent-texts/style", method: "POST", handler: agentWorkerRoute(texStyleRoutes.agentTextsStyleHandler) });
http.route({ path: "/agent-texts/group/style", method: "POST", handler: agentWorkerRoute(texStyleRoutes.agentTextsGroupStyleHandler) });
/* "Tex, share my chats with the devs", or stop (`functions/texReviews.ts` `setTextsReviewSharing`). */
http.route({ path: "/agent-texts/review-sharing", method: "POST", handler: agentWorkerRoute(texReviewSharing.agentTextsReviewSharingHandler) });
export const agentTextsSetup = agentWorkerRoute(agentTexts.agentTextsSetupHandler);
http.route({ path: "/agent-texts/setup", method: "POST", handler: agentTextsSetup });
http.route({ path: "/agent-texts/ready", method: "POST", handler: agentWorkerRoute(agentTexts.agentTextsReadyHandler) });
http.route({ path: "/agent-texts/gmail", method: "POST", handler: agentWorkerRoute(agentTexts.agentTextsGmailHandler) });
http.route({ path: "/agent-texts/vault-saved", method: "POST", handler: agentWorkerRoute(agentTexts.agentTextsVaultSavedHandler) });
http.route({ path: "/agent-texts/phones", method: "POST", handler: agentWorkerRoute(agentTexts.agentTextsPhonesHandler) });
// The picture Tex texts beside a note's link (`apps/agent/src/noteCards.ts`).
http.route({ path: "/agent-texts/note-card", method: "POST", handler: agentWorkerRoute(noteCard.agentTextsNoteCardHandler) });

/* Routines and Tex's nightly dreams: what is due now, and how each went (a code, never text). */
export const agentRoutinesDue = agentWorkerRoute(routines.agentRoutinesDueHandler);
export const agentRoutinesResult = agentWorkerRoute(routines.agentRoutinesResultHandler);
http.route({ path: "/agent-texts/routines/due", method: "POST", handler: agentRoutinesDue });
http.route({ path: "/agent-texts/routines/result", method: "POST", handler: agentRoutinesResult });
http.route({ path: "/agent-texts/dreams/due", method: "POST", handler: agentWorkerRoute(dreams.agentDreamsDueHandler) });
http.route({ path: "/agent-texts/dreams/result", method: "POST", handler: agentWorkerRoute(dreams.agentDreamsResultHandler) });
/* Tex's check-ins (`functions/heartbeats.ts`): the same shape as dreams, plus the person's own phones to text. */
http.route({ path: "/agent-texts/heartbeats/due", method: "POST", handler: agentWorkerRoute(heartbeats.agentHeartbeatsDueHandler) });
http.route({ path: "/agent-texts/heartbeats/result", method: "POST", handler: agentWorkerRoute(heartbeats.agentHeartbeatsResultHandler) });
/* Tex's housekeeping (`functions/housekeeping.ts`): the same shape as dreams; it texts nobody. */
http.route({ path: "/agent-texts/housekeeping/due", method: "POST", handler: agentWorkerRoute(housekeeping.agentHousekeepingDueHandler) });
http.route({ path: "/agent-texts/housekeeping/result", method: "POST", handler: agentWorkerRoute(housekeeping.agentHousekeepingResultHandler) });

export default http;
