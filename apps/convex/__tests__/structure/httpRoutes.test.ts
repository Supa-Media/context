import { describe, expect, test } from "vitest";
import {
  type AnalyzedModule,
  type Classification,
  analyze,
  CREDENTIAL_HTTP_ROUTES,
  findViolations,
  realModules,
} from "./fixtures.helpers";

/**
 * Split out of the original `structure.test.ts`. See `fixtures.helpers.ts` for the
 * analyzer this describe block drives and for the full header comment
 * explaining what the whole suite defends.
 *
 * The route-factory constants and `unauthenticatedRouteResponses` below were
 * moved here rather than into `fixtures.helpers.ts` because nothing outside this file
 * uses them.
 */

/**
 * THE FACTORIES A ROUTE IN `http.ts` MAY BE BUILT BY.
 *
 * Every one of them must require a shared secret before the handler runs, and
 * the test below reads each factory's body to check that it does. The set is
 * enumerated for the same reason `CREDENTIAL_HTTP_ROUTES` is: adding another
 * door is a diff to this file that a reviewer sees, rather than a route that
 * quietly checks nothing.
 *
 * They are separate factories because the two callers have different powers and
 * hold different secrets — see `EMAIL_WORKER_SECRET_ENV_VAR` in
 * `functions/lib/gatewayAuth.ts`. A test below asserts they really do read
 * different environment variables, so collapsing them into one shared secret
 * fails here.
 */
const ROUTE_FACTORIES: Record<string, string> = {
  gatewayRoute: "requestIsFromGateway",
  emailWorkerRoute: "requestIsFromEmailWorker",
};

/**
 * THE FACTORIES WHOSE KEY IS A SIGNATURE RATHER THAN A BEARER SECRET.
 *
 * Kept apart from `ROUTE_FACTORIES` rather than folded into it, because the
 * two tests below ask different questions of the two kinds and folding them
 * would mean one of those questions being asked of a route it does not fit —
 * which is how an enumeration stops meaning anything.
 *
 * A bearer factory is checked against `requestCarriesSecret` and against every
 * other bearer factory reading a *different* environment variable. A signature
 * factory cannot be: Stripe posts from an address nobody here controls with no
 * Authorization header at all, which is the entire reason webhooks are signed.
 * What it owes instead is checked in its own test further down — an HMAC over
 * the **raw** body, a timestamp inside that MAC, and a secret read from the
 * environment rather than from `appSecrets`, which is what keeps this route off
 * `CREDENTIAL_HTTP_ROUTES`.
 *
 * One entry, and the enumeration is the point: a second signed door is a diff
 * to this file that a reviewer reads.
 */
const SIGNED_ROUTE_FACTORIES: Record<string, string> = {
  stripeWebhookRoute: "stripeSignatureIsValid",
};

/** Every factory a route in `http.ts` may be built by, of either kind. */
const ALL_ROUTE_FACTORIES: Record<string, string> = {
  ...ROUTE_FACTORIES,
  ...SIGNED_ROUTE_FACTORIES,
};

/**
 * THE ROUTES THAT REQUIRE NO SECRET AT ALL.
 *
 * There is one, and the enumeration is the point: a route that checks nothing
 * has to be named here, in this file, in a diff a reviewer reads — never
 * something a handler quietly is.
 *
 * `sharePreview` answers a **link-preview crawler**, which has no session and
 * never will, and it is reached only through `infra/router`. A shared secret
 * would be a fourth credential to rotate for a value the request already
 * carries: the caller presents a share token, 32 bytes from
 * `crypto.getRandomValues` that only the owner and the person they sent it to
 * have seen. `infra/router/src/preview.ts` refuses to forward anything that is
 * not shaped like one, so garbage never reaches this deployment.
 *
 * What makes it safe is not the absence of a secret — it is what the route can
 * say. `previewTitleForToken` returns one field, `title`, and returns `null`
 * for an unknown token, a revoked share, an expired one, and one whose owner
 * turned the title off, so a crawler cannot tell any of them apart. The title
 * itself is owner-chosen or derived from the note's filename and is **never
 * read from the note**, so an unfurl costs the customer's bucket nothing.
 *
 * The tests in `sharePreview.test.ts` are what hold that; the entry here is
 * what stops a second one being added without the same argument.
 */
const UNAUTHENTICATED_HTTP_ROUTES = new Set([
  "sharePreview",
  "shareCard",
  "shareNotePreview",
  "shareShortLinkPreview",
  "shareShortLinkCard",
  "domainResolve",
  "sitePreview",
  "siteCard",
]);

/**
 * Every response an unauthenticated route can produce, as its field names.
 *
 * A handler has more than one `return` — the success path and an early answer
 * for a malformed body — and a field added to the quiet one reaches the same
 * anonymous crawler on every bad request. Pinning the last literal, or the
 * first, is pinning half a route: measured, `owner: "seyi", notes: 42` on
 * either handler's early return passed all 39 checks here and the whole 1543
 * convex suite.
 *
 * It also asserts that **every** `return` is one of those literals. Without
 * that, the loop is satisfied by a handler that keeps its two `json({…})`
 * calls and adds a third branch returning a bare `new Response` — which was
 * also measured green.
 */
/**
 * A route's implementation, wherever `http.ts` keeps it.
 *
 * Most are written inline. Some are delegated to a module, the arrangement
 * `gatewayRoutes/` uses and which `publicRoutes/` now uses too, and a
 * delegated handler must not fall out of these checks just because it moved:
 * a guard that follows the declaration rather than the code is decor. So the
 * inline form is tried first and the delegated one second, and a name that
 * matches neither fails loudly rather than yielding an empty body — which is
 * the failure mode that would make every assertion below vacuous.
 */
function routeImplementation(source: string, handlerName: string): string {
  const inline = source.indexOf(`export const ${handlerName} = httpAction(async`);
  if (inline > -1) return source.slice(inline, source.indexOf("\n});", inline));

  const delegated = source.indexOf(`export async function ${handlerName}Handler(`);
  expect(
    delegated,
    `${handlerName} is enumerated but defined neither inline nor as a delegated handler`,
  ).toBeGreaterThan(-1);
  return source.slice(delegated, source.indexOf("\n}\n", delegated));
}

function unauthenticatedRouteResponses(
  source: string,
  handlerName: string,
): string[][] {
  const body = routeImplementation(source, handlerName);

  const returns = [...body.matchAll(/\breturn\s+([\s\S]{0,20}?)[({]/g)].map(
    (m) => m[0].replace(/\s+/g, " "),
  );
  for (const statement of returns) {
    expect(
      statement,
      `${handlerName} answers with something other than json(...): ${statement}`,
    ).toMatch(/return json\(/);
  }

  const literals = [...body.matchAll(/json\(\{([^{}]*)\}\)/g)];
  expect(
    literals.length,
    `${handlerName} should answer with flat object literals only`,
  ).toBe(returns.length);

  return literals.map(([, literal]) =>
    [...literal.matchAll(/([a-zA-Z_$][\w$]*)\s*:/g)].map((m) => m[1]!).sort(),
  );
}

/**
 * THE HTTP SURFACE.
 *
 * `http.ts` carries the nine routes the MCP gateway resolves every request
 * through, and one of them exists specifically to hand out a decrypted storage
 * credential. Until these tests existed the analyzer could not see any of
 * them: `classify` returned `null` for an `httpAction`, so no route was a node,
 * no route had edges, and a route reaching `getBindingForGateway` produced
 * silence — the exact failure the reviewer's `functions/gateway.ts` attack
 * demonstrated for public actions, reachable through a different door.
 *
 * The rules here are stricter than the ones for `api`/`internal` functions,
 * because an HTTP route has no argument validator and no function-name gate in
 * front of it — only whatever its own handler checks first.
 */
describe("the gateway's HTTP routes", () => {
  /**
   * The fourteen routes the contracts document, by the path each is served at.
   *
   * Eleven from `apps/mcp/src/controlPlane.js` (the MCP gateway) and three from
   * `infra/email-worker/src/controlPlane.ts` (the Email Worker). A worker that
   * POSTs to a path this deployment does not serve gets a 404 and fails closed,
   * which is exactly what happened before the ingest three existed — so pinning
   * the paths here is what keeps "the contract" and "the routes" the same list.
   *
   * `/gateway/usage` had been served and called for some time without being
   * pinned here, which is the failure this list exists to prevent, one route
   * later. It is listed now, along with the search-index progress route.
   */
  const CONTRACT_ROUTES: Record<string, string> = {
    "/gateway/session": "gatewaySession",
    "/gateway/sessions/by-grant": "gatewaySessionsByGrant",
    "/gateway/binding": "gatewayBinding",
    "/gateway/search-index/progress": "gatewaySearchIndexProgress",
    "/gateway/jobs/create": "gatewayJobsCreate",
    "/gateway/jobs/open": "gatewayJobsOpen",
    "/gateway/jobs/report": "gatewayJobsReport",
    "/gateway/usage": "gatewayUsage",
    "/gateway/clients/register": "gatewayClientsRegister",
    "/gateway/clients/get": "gatewayClientsGet",
    "/gateway/authorize/start": "gatewayAuthorizeStart",
    "/gateway/codes/consume": "gatewayCodesConsume",
    "/gateway/grants/create": "gatewayGrantsCreate",
    "/gateway/grants/rotate": "gatewayGrantsRotate",
    "/gateway/grants/revoke": "gatewayGrantsRevoke",
    "/gateway/ingest/resolve": "gatewayIngestResolve",
    "/gateway/ingest/binding": "gatewayIngestBinding",
    "/gateway/ingest/record": "gatewayIngestRecord",
  };

  function httpModule(): AnalyzedModule {
    const module = realModules().find((m) => m.path === "http.ts");
    expect(module, "http.ts is not being analyzed at all").toBeDefined();
    return module!;
  }

  /**
   * `http.ts` plus the modules it hands route bodies to.
   *
   * The route table stays in `http.ts` — one place that says what is served
   * and behind which door — but a handler's body may live beside its
   * neighbours. These checks are about the bodies, so they read both.
   */
  function routedSource(): string {
    const delegated = realModules().filter((m) =>
      m.path.startsWith("functions/lib/publicRoutes/"),
    );
    expect(
      delegated.length,
      "publicRoutes/ is not being analyzed, so a handler moved there is unchecked",
    ).toBeGreaterThan(0);
    return [httpModule(), ...delegated].map((m) => m.source).join("\n");
  }

  /**
   * Non-vacuity, and the thing that was actually broken. If `classify` stops
   * recognising `isHttp`, every other test in this block passes over an empty
   * set and proves nothing.
   */
  test("the analyzer classifies every control-plane route as an HTTP node", () => {
    const module = httpModule();
    for (const name of Object.values(CONTRACT_ROUTES)) {
      expect(module.exports[name], `http.ts#${name} is not classified`).toEqual(
        {
          kind: "http",
          isPublic: true,
          isInternal: false,
        },
      );
    }
  });

  /** …and that each is actually wired to the path the contract names. */
  test("each route is registered at its documented path, POST only", () => {
    const source = httpModule().source;
    for (const [path, name] of Object.entries(CONTRACT_ROUTES)) {
      const registration = new RegExp(
        `path:\\s*"${path.replace(/\//g, "\\/")}",\\s*method:\\s*"POST",\\s*handler:\\s*${name}`,
      );
      expect(
        registration.test(source.replace(/\s+/g, " ")),
        `${path} is not routed to ${name} as a POST`,
      ).toBe(true);
    }
  });

  /**
   * PROOF #1 CANNOT BE FORGOTTEN.
   *
   * Twelve handlers each remembering to check a shared secret is twelve chances
   * to forget, and the thirteenth route somebody adds in a hurry is the one
   * that does. So the check is not something a route *does*, it is something a
   * route *is*: every export is built by one of the enumerated factories, and
   * every factory refuses anything without its secret.
   */
  test("every route in http.ts is built by an enumerated secret-checking factory", () => {
    const source = httpModule().source;
    const declarations = [
      ...source.matchAll(/^export const (\w+)\s*=\s*(\w+)\(/gm),
    ];
    expect(declarations.length, "no routes found in http.ts").toBeGreaterThan(
      0,
    );
    for (const [, name, factory] of declarations) {
      if (UNAUTHENTICATED_HTTP_ROUTES.has(name)) continue;
      expect(
        Object.keys(ALL_ROUTE_FACTORIES),
        `http.ts#${name} is built by ${factory}, which is not one of the enumerated route factories — so nothing forces it to require a secret`,
      ).toContain(factory);
    }
  });

  /**
   * The exemption is a pin, not an amnesty.
   *
   * An enumeration nobody checks the size of is a list that grows. This fails
   * if a second unauthenticated route appears, which forces the conversation
   * that entry #1 already had — the same discipline `CREDENTIAL_BARRIERS`
   * follows one section above.
   */
  test("the routes that require no secret are exactly the four share previews", () => {
    // `shareCard` joined `sharePreview` when the card moved into the
    // customer's bucket. It discloses strictly less than its neighbour — the
    // same owner-chosen title, as a picture — and is bounded the same way: a
    // 64-character CSPRNG token the owner handed out, a key computed from that
    // token rather than supplied, and one 404 for every absence.
    expect([...UNAUTHENTICATED_HTTP_ROUTES]).toEqual([
      "sharePreview",
      "shareCard",
      // The third, and the only one whose argument is guessable. It answers
      // only for notes the owner has explicitly team-linked, which is what
      // keeps the probe to the set they already chose to publish — see
      // `previewForNote`.
      //
      // **A folder link learned to name what is inside it and this list did not
      // grow**, which is the part worth stating: the contents are a field on
      // this route rather than a fourth route, so the argument that had to be
      // made three times has not had to be made a fourth. The exemption is a
      // pin, not an amnesty, and a route added here still owes it in full.
      "shareNotePreview",
      // **The fourth, and the first added since the sentence above was
      // written.** A short link is `/@seyi/intake`, so its argument is
      // guessable like the third's and bounded the same way: the probe space
      // is names the *owner* typed, and `shortLinkSlugRejection` refuses every
      // name this product writes so the guessable ones cannot be claimed.
      //
      // It could not be a field on the third: that route's second argument is
      // a note path and this one's is not a path at all, and one route whose
      // argument means two things is how a field nobody looked at reaches an
      // anonymous crawler.
      //
      // The missing field is still the point: `cardToken` is safe on the third
      // because a team link's token is a locator, and a short link may sit
      // over an `anyone` share where the token IS the authorization. What
      // changed is that a short link now unfurls with its own card anyway —
      // see the fifth entry, which is how, and the test below, which is why
      // that is not the mistake this list warned about.
      "shareShortLinkPreview",
      // **The fifth**, and the only one that answers with bytes rather than
      // JSON besides `shareCard`. Its argument is a handle and a slug — the
      // same two the fourth takes, and guessable the same way — so it is
      // bounded the same way, and one 404 covers every absence: no such name,
      // no such slug, a link shared with named people, a card that was never
      // drawn, a title changed since the last successful render.
      //
      // It exists because the alternative was the mistake the fourth entry
      // warns about. A card used to be addressable only by the share's token,
      // so giving short links an image looked like it required publishing one.
      // Addressing the picture by the name the crawler already typed requires
      // publishing nothing.
      "shareShortLinkCard",
      // **The sixth**, and the only one that is not about a share. Its
      // argument is a hostname — guessable, and it has to be: the router asks
      // it for every request that arrives at a customer's domain. It answers
      // with what that domain already publishes by serving: the handle its
      // links resolve under and which link its root opens. Every other case —
      // unknown, unverified, suspended, removed, unpaid — is one null shape,
      // so it is a directory of live sites and nothing else.
      "domainResolve",
      // **The seventh and eighth**, a pair like the fourth and fifth: a
      // website page's tags and its picture. Their argument is a handle and a
      // route path, guessable, and they answer only for a live public page of
      // a site its owner turned on, resolved exactly as for an anonymous
      // visitor (`lib/websites/preview.ts`). What they disclose is what that
      // address already shows anyone who opens it: the title, the site's name
      // and one line of the page. Every other case is one null shape, or one
      // 404 for the picture. See the test below for the fields.
      "sitePreview",
      "siteCard",
    ]);

    const source = httpModule().source;
    const start = source.indexOf("export const sharePreview");
    expect(start, "sharePreview is enumerated but not defined").toBeGreaterThan(
      -1,
    );
    const body = source.slice(start, source.indexOf("\n});", start));

    /**
     * **Two fields wide now, and the second one had to be argued for.**
     *
     * This said "one field wide, or it is a different route", which was the
     * right bar and is not a bar against ever having two. The card's
     * description read "Sign in to read it" — true of every share there was,
     * false of an unlisted link, and a card that tells a stranger to sign in
     * when they need no account is the product being wrong on the first
     * surface they see.
     *
     * `openToAnyone` passes the test every field here has to pass: it
     * discloses nothing a crawler could not learn by following the link it is
     * already holding, and it is `false` for every absence, so the *tuple* is
     * byte-identical for unknown, revoked, expired and title-less shares.
     *
     * The fields are pinned by name and a spread is refused, because the
     * failure to expect on an unauthenticated route is a third field arriving
     * from upstream that nobody looked at.
     */
    expect(body).toContain("previewTitleForToken");
    expect(body).toMatch(
      /json\(\{\s*title:\s*result\.title,\s*openToAnyone:\s*result\.openToAnyone\s*\}\)/,
    );
    expect(
      body,
      "sharePreview must not spread its upstream result",
    ).not.toMatch(/\.\.\.result/);
    for (const forbidden of [
      "workspaceId",
      "slug",
      "entryPath",
      "recipient",
      "createdBy",
    ]) {
      expect(body, `sharePreview must not return ${forbidden}`).not.toContain(
        forbidden,
      );
    }

    // **EVERY response, not the last one**, and every response a `json(`.
    // See `unauthenticatedRouteResponses`.
    for (const keys of unauthenticatedRouteResponses(source, "sharePreview")) {
      expect(
        keys,
        "every sharePreview response returns exactly these fields",
      ).toEqual(["openToAnyone", "title"]);
    }
  });

  /**
   * **The third route is three fields wide, and each one was argued for.**
   *
   * `title` is the note's or folder's own name; `cardToken` is a locator that
   * grants nothing, because a team share's reader is authorised by membership
   * on every request; `children` is two or three names from inside a linked
   * folder, filtered to what a `team` reader may see and bounded in
   * `previewForNote` before it gets here.
   *
   * The exact shape is pinned rather than a subset, because the failure to
   * expect on an unauthenticated route is a field being added upstream and
   * arriving here by a spread nobody looked at. `shareNotePreview` names its
   * three fields for that reason, and this reads them back.
   *
   * **`children` growing is the thing to watch.** The field is the only list on
   * any of these three routes, and the addition that would look like an
   * improvement — a count of what is inside — is the one that must never be
   * made from anything but the visible names themselves.
   */
  /**
   * A website page's route is four fields wide, on every return: the page's
   * title, one line of description, the site's name, and a card version that
   * is a digest of the two names. Nothing else a page resolution carries
   * (the Markdown, the navigation, the audience, the workspace) may leave.
   */
  test("the website page route returns four fields and no more", () => {
    const source = routedSource();
    for (const keys of unauthenticatedRouteResponses(source, "sitePreview")) {
      expect(keys, "every sitePreview response returns exactly these fields").toEqual([
        "cardVersion",
        "description",
        "siteName",
        "title",
      ]);
    }
    const body = routeImplementation(source, "sitePreview");
    expect(body, "sitePreview must name its fields, never spread them").not.toMatch(/\.\.\./);
    for (const forbidden of ["markdown", "navigation", "workspaceId", "audience"]) {
      expect(body, `sitePreview must not return ${forbidden}`).not.toContain(forbidden);
    }
  });

  test("the readable team link's route returns three fields and no more", () => {
    const source = httpModule().source;
    const start = source.indexOf("export const shareNotePreview");
    expect(
      start,
      "shareNotePreview is enumerated but not defined",
    ).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n});", start));

    expect(body).toContain("previewForNote");
    for (const field of ["title:", "cardToken:", "children:"]) {
      expect(body, `shareNotePreview must return ${field}`).toContain(field);
    }
    // A spread would let a field added upstream reach the internet without
    // anybody deciding it should.
    expect(
      body,
      "shareNotePreview must name its fields, never spread them",
    ).not.toMatch(/json\(\s*\{?\s*\.\.\.|json\(result\)/);

    // …and THREE, not "at least three". Asserting the names are present and
    // denying four literals by name is not the same as bounding the object:
    // adding `noteCount: 42,` to the returned literal passed this test and all
    // 1482 checks beside it, and shipped a count on an unauthenticated route —
    // which is the one addition CLAUDE.md says must never be made from anything
    // but the visible names themselves. The keys are read out of the literal
    // rather than listed here, so a rename fails loudly instead of silently
    // widening the exemption.
    //
    // Read from EVERY response rather than the last, which is the hole the
    // sibling route's pin had and this one kept: `body.lastIndexOf("return
    // json({")` skipped the early answer for a malformed body, and
    // `owner: "seyi", noteCount: 42` on that branch passed all 39 checks here.
    for (const keys of unauthenticatedRouteResponses(
      source,
      "shareNotePreview",
    )) {
      expect(
        keys,
        "every shareNotePreview response returns exactly these fields",
      ).toEqual(["cardToken", "children", "title"]);
    }
    for (const forbidden of [
      "workspaceId",
      "recipient",
      "createdBy",
      "entryPath",
    ]) {
      expect(
        body,
        `shareNotePreview must not return ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });

  /**
   * **The field this route does not have is still the one that matters, and
   * short links have a card image anyway.**
   *
   * The comment here used to end: "the shape of this addition, a year from
   * now, is somebody noticing that short links have no card image and fixing
   * it by copying the field from the route above." That happened, in rather
   * less than a year, and the warning did its job — the fix is **not** the
   * copied field.
   *
   * `shareNotePreview` returns a `cardToken` because a team link's token is a
   * locator: its reader is authorised by membership on every request, so
   * handing it to a crawler grants nothing. A short link may sit over an
   * `anyone` share, where possession of the token **is** the authorization —
   * so the same field here would hand whoever guessed a name a capability that
   * outlives the name and keeps working after the slug is released. That is
   * unchanged and the forbidden list below is unchanged with it.
   *
   * What changed is the premise underneath it, which was never stated as an
   * assumption: *a card is addressed by the share's token*. It does not have
   * to be. `shareShortLinkCard` addresses the same picture by the handle and
   * slug the crawler already used to ask for the title, so the image arrives
   * and the token stays where it was.
   *
   * The second field is therefore `cardVersion` — an opaque digest of what the
   * card draws, which the edge needs because the Workers Cache API cannot
   * invalidate an image and a different URL is the only invalidation there is.
   * It is a digest rather than the ingredients on purpose: a folder card draws
   * names from inside the folder, and those names are not what a short link's
   * preview discloses.
   */
  test("the short link's route returns its two fields, and never the token", () => {
    const source = routedSource();
    const body = routeImplementation(source, "shareShortLinkPreview");

    expect(body).toContain("previewForShortLink");
    expect(
      body,
      "shareShortLinkPreview must name its fields, never spread them",
    ).not.toMatch(/json\(\s*\{?\s*\.\.\.|json\(result\)/);

    for (const keys of unauthenticatedRouteResponses(
      source,
      "shareShortLinkPreview",
    )) {
      expect(
        keys,
        "every shareShortLinkPreview response returns exactly these fields",
      ).toEqual(["cardVersion", "title"]);
    }

    for (const forbidden of [
      "cardToken",
      "token",
      "workspaceId",
      "entryPath",
      "recipient",
      "createdBy",
    ]) {
      expect(
        body,
        `shareShortLinkPreview must not return ${forbidden}`,
      ).not.toContain(`${forbidden}:`);
    }
  });

  /** And every factory really does check it — otherwise the rule above is decor. */
  test("every factory refuses a request that does not carry its secret", () => {
    const source = httpModule().source;
    for (const [factoryName, guard] of Object.entries(ALL_ROUTE_FACTORIES)) {
      const start = source.indexOf(`function ${factoryName}(`);
      expect(
        start,
        `${factoryName} is enumerated but not defined in http.ts`,
      ).toBeGreaterThan(-1);
      const factory = source.slice(start);
      const body = factory.slice(0, factory.indexOf("\n}\n"));
      expect(body, `${factoryName} does not call ${guard}`).toContain(
        `${guard}(`,
      );
      expect(body, `${factoryName} does not refuse`).toMatch(
        /unauthorized\(\)/,
      );
    }

    // …and the comparison is constant-time and length-blind, so the secret's
    // length is not readable from a timing difference.
    const gatewayAuth = realModules().find(
      (m) => m.path === "functions/lib/gatewayAuth.ts",
    );
    expect(gatewayAuth).toBeDefined();
    expect(gatewayAuth!.source).toMatch(/constantTimeEqualsHex/);
    expect(gatewayAuth!.source).toMatch(/hashToken\(presented\)/);
  });

  /**
   * THE TWO DOORS HAVE TWO KEYS.
   *
   * The email worker's secret buys a storage credential with no human in the
   * loop; the gateway's buys nothing without one. Collapsing them into a single
   * shared value — the obvious "simplification", since both are just bearer
   * secrets — would mean a stolen email-worker secret is a working MCP gateway
   * and a stolen gateway secret is a way into people's buckets. A comment saying
   * "these are deliberately different" cannot fail. This can.
   */
  test("each route factory's guard reads a different secret", () => {
    const gatewayAuth = realModules().find(
      (m) => m.path === "functions/lib/gatewayAuth.ts",
    )!;

    const envVarOf = (guard: string): string => {
      const start = gatewayAuth.source.indexOf(
        `export async function ${guard}(`,
      );
      expect(
        start,
        `${guard} is not defined in gatewayAuth.ts`,
      ).toBeGreaterThan(-1);
      const body = gatewayAuth.source.slice(start);
      const match = /requestCarriesSecret\(\s*request,\s*(\w+)/.exec(
        body.slice(0, body.indexOf("\n}\n")),
      );
      expect(
        match,
        `${guard} does not delegate to requestCarriesSecret`,
      ).not.toBeNull();
      return match![1];
    };

    const guards = Object.values(ROUTE_FACTORIES);
    const envVars = guards.map(envVarOf);
    expect(
      new Set(envVars).size,
      `two route factories share one secret: ${envVars.join(", ")}`,
    ).toBe(guards.length);

    // Non-vacuity: those constant names have to be real, and hold the values
    // the deployment actually configures.
    expect(gatewayAuth.source).toMatch(
      /export const GATEWAY_SECRET_ENV_VAR = "GATEWAY_SECRET"/,
    );
    expect(gatewayAuth.source).toMatch(
      /export const EMAIL_WORKER_SECRET_ENV_VAR = "EMAIL_WORKER_SECRET"/,
    );
  });

  /**
   * THE SIGNED DOOR OWES WHAT THE BEARER DOORS OWE, IN ITS OWN CURRENCY.
   *
   * A webhook route cannot be checked against `requestCarriesSecret` — its
   * caller has no Authorization header and never will — so being exempt from
   * the two tests above would leave it with no structural obligation at all,
   * which is precisely how a route that "checks a signature" ends up checking
   * a signature it computed over something else.
   *
   * Four properties, each of which has been somebody's published incident:
   *
   *  - the MAC is over the **raw body**. `request.text()` before any
   *    `JSON.parse`, and the parse happens after the check. Re-serialising the
   *    parsed object verifies a different document from the one that was
   *    signed;
   *  - the secret is read from `process.env`, not from `appSecrets` — which is
   *    what keeps this route off `CREDENTIAL_HTTP_ROUTES` and is asserted
   *    positively rather than left to the decrypt graph;
   *  - a failure is `unauthorized()`, the same opaque refusal every other door
   *    gives; and
   *  - the verifier itself checks the timestamp, so a captured delivery is not
   *    a standing key.
   */
  test("the signed route factory verifies the raw body against an environment secret", () => {
    const source = httpModule().source;
    for (const [factoryName, guard] of Object.entries(SIGNED_ROUTE_FACTORIES)) {
      const start = source.indexOf(`function ${factoryName}(`);
      expect(
        start,
        `${factoryName} is enumerated but not defined in http.ts`,
      ).toBeGreaterThan(-1);
      const factory = source.slice(start);
      const body = factory.slice(0, factory.indexOf("\n}\n"));

      expect(body, `${factoryName} does not call ${guard}`).toContain(
        `${guard}(`,
      );
      expect(body, `${factoryName} does not refuse`).toMatch(
        /unauthorized\(\)/,
      );

      // The raw body, and the parse strictly after the verification.
      expect(body, `${factoryName} must verify the raw body`).toMatch(
        /await request\.text\(\)/,
      );
      const verifiedAt = body.indexOf(`${guard}(`);
      const parsedAt = body.indexOf("JSON.parse(");
      expect(
        parsedAt,
        `${factoryName} never parses the body it verified`,
      ).toBeGreaterThan(-1);
      expect(
        parsedAt,
        `${factoryName} parses the body before verifying it`,
      ).toBeGreaterThan(verifiedAt);

      // The secret is an environment read, not a database one.
      expect(
        body,
        `${factoryName} must read its secret from the environment`,
      ).toMatch(/process\.env\[STRIPE_WEBHOOK_SECRET_ENV_VAR\]/);
      expect(
        body,
        `${factoryName} must not open an appSecrets envelope`,
      ).not.toMatch(/readIntegrationSecret|decryptSecret/);
    }

    /*
      Non-vacuity for the last of the four, and it is bound to the guard the
      factory actually names.

      The first version read `lib/stripe.ts` for the tolerance constant no
      matter which function the factory called — so a `fooRoute: "alwaysTrue"`
      that satisfied the four body assertions above would have passed on the
      strength of a constant somewhere else in the file. The guard's own body is
      what has to check a timestamp and compare in constant time, or "signed"
      means "signed at some point in history".
    */
    for (const guard of Object.values(SIGNED_ROUTE_FACTORIES)) {
      const stripe = realModules().find(
        (m) => m.path === "functions/lib/stripe.ts",
      );
      expect(
        stripe,
        "functions/lib/stripe.ts is not in the analysed modules",
      ).toBeDefined();
      const start = stripe!.source.indexOf(`export async function ${guard}(`);
      expect(
        start,
        `${guard} is named by a route factory but is not defined in lib/stripe.ts`,
      ).toBeGreaterThan(-1);
      const guardBody = stripe!.source.slice(start);
      const body = guardBody.slice(0, guardBody.indexOf("\n}\n"));

      expect(body, `${guard} does not check the delivery's timestamp`).toMatch(
        /toleranceMs/,
      );
      expect(body, `${guard} does not compare in constant time`).toMatch(
        /constantTimeEqualsHex\(/,
      );
      // The timestamp has to be inside the MAC as well as checked, or moving it
      // is free.
      expect(
        body,
        `${guard} does not prepend the timestamp to the signed payload`,
      ).toMatch(/\$\{parsed\.timestamp\}\.\$\{payload\}/);
      // And an absent secret must refuse rather than allow.
      expect(
        body,
        `${guard} does not refuse when no signing secret is configured`,
      ).toMatch(/secret\.length === 0\) return false/);
    }

    // The env var the factory reads is a real name, held where the deployment
    // actually sets it — the same non-vacuity `GATEWAY_SECRET_ENV_VAR` gets
    // below, and it was missing for this one.
    const premium = realModules().find(
      (m) => m.path === "functions/lib/premium.ts",
    );
    expect(
      premium,
      "functions/lib/premium.ts is not in the analysed modules",
    ).toBeDefined();
    expect(premium!.source).toMatch(
      /export const STRIPE_WEBHOOK_SECRET_ENV_VAR = "STRIPE_WEBHOOK_SECRET"/,
    );
  });

  /**
   * PROOF #2 CANNOT DEGRADE INTO A LOOKUP.
   *
   * `expectedWorkspaceId` is the gateway's own conclusion, sent so we can
   * refuse a mismatch. The moment it selects a row — a `db.get`, a
   * `normalizeId`, an index `eq`, an assignment into a `workspaceId:` field —
   * the gateway can name the workspace it gets, and a compromised gateway
   * walks the customer list one id at a time with one valid token.
   *
   * A comment saying "veto only" cannot fail. This can.
   */
  test("expectedWorkspaceId is never used as a lookup key", () => {
    for (const module of realModules()) {
      const offenders = lookupUsesOf(module.source, "expectedWorkspaceId");
      expect(
        offenders,
        `${module.path} uses expectedWorkspaceId to select something; it may only ever be compared`,
      ).toEqual([]);
    }
  });

  /** Non-vacuity for the check above: it must catch the thing it forbids. */
  test("the lookup-key check catches the refactor it exists to prevent", () => {
    expect(
      lookupUsesOf(
        `const binding = await ctx.db.get(args.expectedWorkspaceId);`,
        "expectedWorkspaceId",
      ),
    ).toHaveLength(1);
    expect(
      lookupUsesOf(
        `await ctx.runAction(ref, { workspaceId: args.expectedWorkspaceId });`,
        "expectedWorkspaceId",
      ),
    ).toHaveLength(1);
    expect(
      lookupUsesOf(
        `.withIndex("by_workspace", (q) => q.eq("workspaceId", args.expectedWorkspaceId))`,
        "expectedWorkspaceId",
      ),
    ).toHaveLength(1);
    // The real usage — a comparison — must not be flagged, or the check is
    // just noise somebody will delete.
    expect(
      lookupUsesOf(
        `if (args.expectedWorkspaceId !== session.workspaceId) return null;`,
        "expectedWorkspaceId",
      ),
    ).toEqual([]);
  });

  /**
   * The enumerated exception has to be real. A pin naming a route that cannot
   * reach a credential is a stale pin, and a stale pin is how the next one
   * gets added without anyone noticing.
   */
  test("every enumerated credential route is an HTTP route that really reaches the decrypt path", () => {
    const modules = realModules();
    const { decryptCapable } = analyze(modules);
    const classifications = new Map<string, Classification>();
    for (const module of modules) {
      for (const [name, classification] of Object.entries(module.exports)) {
        classifications.set(`${module.reference}.${name}`, classification);
      }
    }

    expect(CREDENTIAL_HTTP_ROUTES.size).toBeGreaterThan(0);
    for (const route of CREDENTIAL_HTTP_ROUTES) {
      expect(
        decryptCapable.has(route),
        `${route} is pinned as a credential route but cannot reach a credential — either it is misnamed or the pin is stale`,
      ).toBe(true);
      expect(classifications.get(route)?.kind).toBe("http");
    }
  });

  /**
   * The attack this extension exists to catch, run through the same analyzer:
   * a *new* route that quietly reaches the decrypt path. Before `classify`
   * understood `isHttp`, this produced no violation at all.
   */
  test("catches a new HTTP route that reaches the decrypt path", () => {
    const attack: AnalyzedModule = {
      reference: "http",
      path: "http.ts",
      source: `
export const gatewayDebugBinding = gatewayRoute(async (ctx, body) => {
  const credential = await ctx.runAction(
    internal.functions.storage.getBindingForGateway,
    { workspaceId: body.workspaceId },
  );
  return json({ binding: credential });
});
`,
      exports: {
        gatewayDebugBinding: {
          kind: "http",
          isPublic: true,
          isInternal: false,
        },
      },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.node)).toContain("http.gatewayDebugBinding");
    expect(violations.map((v) => v.reason).join(" ")).toMatch(
      /enumerated CREDENTIAL_HTTP_ROUTES/,
    );
  });

  /** The indirect form: a new route reaching it through the internal resolver. */
  test("catches a new HTTP route that launders the credential through an internal action", () => {
    const attack: AnalyzedModule = {
      reference: "http",
      path: "http.ts",
      source: `
export const gatewayPeek = gatewayRoute(async (ctx, body) => {
  const binding = await ctx.runAction(
    internal.functions.controlPlane.openStorageBinding,
    { hashedAccessToken: body.hashedAccessToken, expectedWorkspaceId: null },
  );
  return json({ bucket: binding.bucket });
});
`,
      exports: {
        gatewayPeek: { kind: "http", isPublic: true, isInternal: false },
      },
    };

    expect(
      findViolations([...realModules(), attack]).map((v) => v.node),
    ).toContain("http.gatewayPeek");
  });

  /** A route that touches no credential is fine, and must stay fine. */
  test("an ordinary HTTP route is not a violation", () => {
    const benign: AnalyzedModule = {
      reference: "http",
      path: "http.ts",
      source: `
export const gatewayHealth = gatewayRoute(async () => json({ ok: true }));
`,
      exports: {
        gatewayHealth: { kind: "http", isPublic: true, isInternal: false },
      },
    };

    expect(findViolations([...realModules(), benign])).toEqual([]);
  });
});

/**
 * Lines that use `name` to *select* something rather than to compare it.
 *
 * Deliberately line-oriented and deliberately crude: it over-reports rather
 * than under-reports, and an over-report costs a restructure while an
 * under-report costs a customer's bucket.
 */
function lookupUsesOf(source: string, name: string): string[] {
  // Comments are allowed to describe the forbidden refactor — the docstring on
  // `openStorageBinding` names `ctx.db.get(expectedWorkspaceId)` precisely so a
  // reader knows what must never appear. What must not exist is a *use*.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const offenders: string[] = [];
  for (const line of code.split("\n")) {
    if (!line.includes(name)) continue;
    if (/(?:db\.get|normalizeId|withIndex|\.eq)\s*\(/.test(line)) {
      offenders.push(line.trim());
      continue;
    }
    // An assignment into a workspace-id-shaped field. The lookbehind is what
    // keeps `expectedWorkspaceId:` itself — the argument declaration — from
    // matching its own name.
    if (
      /(?<![A-Za-z])workspaceId\s*:\s*[^,\n]*\b\w*expectedWorkspaceId/.test(
        line,
      )
    ) {
      offenders.push(line.trim());
    }
  }
  return offenders;
}
