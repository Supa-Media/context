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
import { api, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { hashToken } from "./functions/lib/crypto";
import { logIngest } from "./functions/lib/ingestLog";
import {
  badRequest,
  json,
  randomOpaqueToken,
  readJsonBody,
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
import * as credentials from "./functions/lib/gatewayRoutes/credentials";
import * as signals from "./functions/lib/gatewayRoutes/signals";
import * as jobs from "./functions/lib/gatewayRoutes/jobs";
import * as oauth from "./functions/lib/gatewayRoutes/oauth";
import * as links from "./functions/lib/gatewayRoutes/links";
import { serverError } from "./functions/lib/gatewayRoutes/responses";
import * as shortLinkCards from "./functions/lib/publicRoutes/shortLinkCards";

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
  handler: (ctx: ActionCtx, body: Record<string, unknown>) => Promise<Response>,
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

/* -------------------------------------------------------------------------- */
/* 2a. POST /gateway/provider — the model account the agent spends            */
/* -------------------------------------------------------------------------- */

export const gatewayProvider = gatewayRoute(credentials.gatewayProviderHandler);

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

/* -------------------------------------------------------------------------- */
/* 2b-tree. POST /gateway/tree — a context's file tree changed               */
/* -------------------------------------------------------------------------- */

export const gatewayTree = gatewayRoute(signals.gatewayTreeHandler);

/* -------------------------------------------------------------------------- */
/* 2b-ter. POST /gateway/website — a write of ours moved the site's bytes   */
/* -------------------------------------------------------------------------- */

export const gatewayWebsite = gatewayRoute(signals.gatewayWebsiteHandler);

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
  return json({ binding, ...(noteCap === null ? {} : { noteCap }) });
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

/**
 * `POST /share/preview` — the title a share link unfurls with.
 *
 * **Unauthenticated on purpose**, and the only route on this deployment that
 * is. It is enumerated in `UNAUTHENTICATED_HTTP_ROUTES` in
 * `__tests__/structure.test.ts`, which pins the exemption to exactly one route
 * and asserts this handler returns nothing but the title.
 *
 * The caller is `infra/router`, answering a crawler that has no session and
 * never will. A shared secret would be a fourth credential to rotate for a
 * value the request already carries: the caller presents a share token, 32
 * bytes from `crypto.getRandomValues` that only the owner and the person they
 * sent it to have ever seen, and the router refuses to forward anything that is
 * not shaped like one. See `functions/shares.ts:previewTitleForToken` for the
 * whole argument, including what it costs.
 *
 * POST rather than GET, like every route below it: a GET would put the share
 * token in a URL, and from there into an access log, a referrer header, and
 * browser history. The token is the capability.
 *
 * Always 200, always `{ "title": string | null, "openToAnyone": boolean }`. A
 * malformed body is the same shape with `null` and `false`, because a crawler
 * cannot act on a 400 and a status code that varied would be one more thing to
 * read — and because every absence on this route has to be one absence, which
 * over two fields means the whole tuple rather than the first of them.
 */
export const sharePreview = httpAction(async (ctx, request) => {
  const body = await readJsonBody(request);
  const token = body === null ? null : stringField(body, "token");
  if (token === null) return json({ title: null, openToAnyone: false });

  const result = await ctx.runQuery(api.functions.shares.previewTitleForToken, {
    token,
  });
  // Both fields named, never a spread of `result`. The failure to expect on an
  // unauthenticated route is a field added upstream arriving here by a spread
  // nobody looked at — which is why `structure.test.ts` pins this handler's
  // fields by name and refuses one.
  return json({ title: result.title, openToAnyone: result.openToAnyone });
});

http.route({ path: "/share/preview", method: "POST", handler: sharePreview });

/**
 * `POST /share/card` — the card image for a share.
 *
 * **The second unauthenticated route**, beside `/share/preview`, and it
 * discloses strictly less than that one: the same title, as a picture. Both are
 * enumerated in `UNAUTHENTICATED_HTTP_ROUTES` in `__tests__/structure.test.ts`,
 * which pins the list and forces this argument to be made again for a third.
 *
 * PNG bytes, or 404. Every absence is one 404 — unknown token, revoked,
 * expired, title switched off, never rendered, bucket unreachable — so a
 * crawler cannot tell a share that was taken back from one that never existed.
 * The router turns any non-200 into the static product card.
 *
 * POST, like every route here: a GET would put the share token in an access
 * log, a referrer header and browser history. The token is the capability.
 */
export const shareCard = httpAction(async (ctx, request) => {
  const body = await readJsonBody(request);
  const token = body === null ? null : stringField(body, "token");
  if (token === null) return new Response(null, { status: 404 });

  const bytes = await ctx.runAction(
    internal.functions.shareCard.cardBytesForToken,
    {
      token,
    },
  );
  if (bytes === null) return new Response(null, { status: 404 });

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // The router caches; this says nothing about how long, because the
      // router's key carries the title hash and is the real invalidation.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

http.route({ path: "/share/card", method: "POST", handler: shareCard });

/**
 * `POST /share/note` — the card for a **readable** team link.
 *
 * `/console/@seyi?note=1-projects/plan.md` is what an owner copies, because a
 * URL pasted into a document should say what it points at. This is what lets it
 * unfurl.
 *
 * **Unauthenticated, and the third such route.** Its argument is a handle and a
 * path, both guessable — unlike the two beside it, whose argument is a CSPRNG
 * token. So this one does open an oracle, and what bounds it is that it answers
 * only for notes the owner has explicitly team-linked: an unlinked note is
 * byte-identical to one that does not exist. See `previewForNote`, which is
 * where that trade is argued.
 *
 * **This route grew a field and did not become a fourth route**, which is the
 * cheap-looking half of the change worth stating. `children` is two or three
 * names from inside a linked folder; it is bounded and privacy-filtered in
 * `previewForNote`, bounded again there on the way out, and bounded a third
 * time at the edge. Answering it from here rather than from a new endpoint
 * keeps `UNAUTHENTICATED_HTTP_ROUTES` at three — the enumeration is a pin
 * rather than an amnesty, and a fourth entry is a conversation this feature did
 * not need to have.
 */
export const shareNotePreview = httpAction(async (ctx, request) => {
  const body = await readJsonBody(request);
  const slug = body === null ? null : stringField(body, "slug");
  const path = body === null ? null : stringField(body, "path");
  if (slug === null || path === null) {
    return json({ title: null, cardToken: null, children: [] });
  }

  const result = await ctx.runQuery(api.functions.shares.previewForNote, {
    slug,
    path,
  });
  // Named rather than spread, so the shape of what leaves this deployment
  // unauthenticated is legible in this file and cannot grow by a field being
  // added upstream. `structure.test.ts` reads this body and asserts it.
  return json({
    title: result.title,
    cardToken: result.cardToken,
    children: result.children,
  });
});

http.route({ path: "/share/note", method: "POST", handler: shareNotePreview });

/**
 * `POST /share/short` — the card for a short link, `/@seyi/intake`.
 *
 * **The fourth unauthenticated route, and the first one added since this list
 * was called "a pin, not an amnesty".** So the argument in full, on its own
 * terms.
 *
 * *Why it cannot be a field on one of the other three.* `/share/note` takes a
 * handle and a note path; this takes a handle and a name that is not a path
 * and does not resolve like one. Folding them together would mean one route
 * whose second argument means two things depending on a flag, and the failure
 * that list exists to prevent is exactly a field nobody looked at reaching an
 * anonymous crawler.
 *
 * *Why it may answer at all, when `/@seyi` may not.* The same hinge
 * `/share/note` turns on: the probe space is names the **owner** chose. There
 * is no list of likely slugs — a slug exists only where somebody typed one —
 * and `shortLinkSlugRejection` refuses every name this product writes, so the
 * guessable ones cannot be claimed in the first place. What a prober learns is
 * the title of something its owner deliberately published at a memorable
 * address, which is the feature.
 *
 * *What it costs, stated.* Anyone holding or guessing the URL learns the title
 * without signing in, and a card that has already unfurled is cached by the
 * platform that unfurled it and cannot be recalled. Content still needs the
 * live share; revocation is enforced at the destination, where it is immediate.
 *
 * *One field, and never the token.* `/share/note` returns a `cardToken`
 * because a team link's token is a locator — its reader is authorised by
 * membership on every request. A short link may sit over an `anyone` share,
 * where the token **is** the authorization, so handing it to whoever guessed
 * the name would be a capability outliving the name it was published at. This
 * route therefore returns the title alone, and a short link unfurls with the
 * product's own image rather than a per-share card.
 *
 * Always 200, always `{ "title": string | null }`. Every absence — unknown
 * handle, unclaimed name, released, revoked, expired, title switched off — is
 * that shape with `null`.
 */
export const shareShortLinkPreview = httpAction(
  shortLinkCards.shareShortLinkPreviewHandler,
);

http.route({
  path: "/share/short",
  method: "POST",
  handler: shareShortLinkPreview,
});

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

http.route({
  path: "/share/short/card",
  method: "POST",
  handler: shareShortLinkCard,
});

/* -------------------------------------------------------------------------- */
/* POST /domain/resolve — which workspace a customer domain serves             */
/* -------------------------------------------------------------------------- */

/**
 * The router's question for a request that arrived at a customer's domain.
 *
 * Always 200, always `{ "handle": string | null, "homeSlug": string | null }`:
 * unknown, pending, suspended and removed domains are all the null shape, so
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

export const gatewayUsage = gatewayRoute(signals.gatewayUsageHandler);

/* -------------------------------------------------------------------------- */

// POST only, every one of them. The contract has no GET shape, and a GET would
// put a token in a URL — in a log, in a referrer, in browser history.
http.route({
  path: "/gateway/session",
  method: "POST",
  handler: gatewaySession,
});
http.route({
  path: "/gateway/sessions/by-grant",
  method: "POST",
  handler: gatewaySessionsByGrant,
});
http.route({
  path: "/gateway/binding",
  method: "POST",
  handler: gatewayBinding,
});
http.route({
  path: "/gateway/provider",
  method: "POST",
  handler: gatewayProvider,
});
http.route({
  path: "/gateway/search-index/progress",
  method: "POST",
  handler: gatewaySearchIndexProgress,
});
http.route({
  path: "/gateway/activity",
  method: "POST",
  handler: gatewayActivity,
});
http.route({ path: "/gateway/tree", method: "POST", handler: gatewayTree });
http.route({
  path: "/gateway/website",
  method: "POST",
  handler: gatewayWebsite,
});
http.route({
  path: "/gateway/forms/notify",
  method: "POST",
  handler: gatewayFormsNotify,
});
http.route({
  path: "/gateway/jobs/create",
  method: "POST",
  handler: gatewayJobsCreate,
});
http.route({
  path: "/gateway/jobs/open",
  method: "POST",
  handler: gatewayJobsOpen,
});
http.route({
  path: "/gateway/jobs/report",
  method: "POST",
  handler: gatewayJobsReport,
});
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
/* -------------------------------------------------------------------------- */
/* Links, for an agent that asked for one                                     */
/* -------------------------------------------------------------------------- */

export const gatewayLinksCreate = gatewayRoute(links.gatewayLinksCreateHandler);

http.route({
  path: "/gateway/links/create",
  method: "POST",
  handler: gatewayLinksCreate,
});

export const gatewayLinksList = gatewayRoute(links.gatewayLinksListHandler);

http.route({
  path: "/gateway/links/list",
  method: "POST",
  handler: gatewayLinksList,
});

export const gatewayLinksRevoke = gatewayRoute(links.gatewayLinksRevokeHandler);

http.route({
  path: "/gateway/links/revoke",
  method: "POST",
  handler: gatewayLinksRevoke,
});

http.route({ path: "/gateway/usage", method: "POST", handler: gatewayUsage });

export default http;
