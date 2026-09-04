/**
 * The control-plane client — the gateway's only door to Convex.
 *
 * ============================================================================
 * THE CONTRACT
 * ============================================================================
 *
 * The gateway holds no database. Everything it needs to answer a request —
 * who is calling, which workspaces they may reach, and the credential for that
 * workspace's bucket — comes from the control plane over HTTPS.
 *
 * Transport, for every operation without exception:
 *
 *   POST `${CONTROL_PLANE_URL}${path}`
 *   Authorization: Bearer ${GATEWAY_SECRET}
 *   Content-Type: application/json
 *   Accept: application/json
 *   body: JSON object
 *
 * `CONTROL_PLANE_URL` is the Convex HTTP-actions origin (`https://<deployment>.convex.site`),
 * with no trailing slash. `GATEWAY_SECRET` is a shared secret held by exactly
 * two parties. It is never logged, never echoed into a response, never placed
 * in a URL or a query string, and never written to a bucket.
 *
 * ----------------------------------------------------------------------------
 * THE GATEWAY SECRET IS NOT SUFFICIENT, AND MUST NEVER BECOME SUFFICIENT
 * ----------------------------------------------------------------------------
 *
 * Read this before "simplifying" anything below. The simplification is obvious,
 * looks like a cleanup, and is a catastrophe.
 *
 * A storage binding is fetched with **two independent proofs**, both validated
 * server-side by Convex:
 *
 *   1. `GATEWAY_SECRET` in the `Authorization` header — proves *this caller is
 *      the gateway*.
 *   2. **The end user's OAuth access token, forwarded verbatim from the inbound
 *      MCP request** — proves *a real person authorized access to this specific
 *      workspace, and their grant is live right now*.
 *
 * And the authority runs one way only: **the gateway does not get to name the
 * workspace it wants.** Convex resolves the user's access token to a grant and
 * derives the workspace from *that grant*. `expectedWorkspaceId` is passed only
 * so Convex can *reject a mismatch* — it is never the thing Convex looks up by.
 *
 * The properties this buys, which are the entire point:
 *
 *   - A leaked `GATEWAY_SECRET` on its own yields **nothing**. No user token,
 *     no credentials, no enumeration.
 *   - A stolen user access token on its own yields nothing either: it cannot
 *     reach the control plane without the gateway secret.
 *   - The blast radius of a fully compromised gateway is bounded by "workspaces
 *     whose users are actively connecting right now", not "every workspace that
 *     has ever existed".
 *   - **Bulk extraction is impossible by construction.** There is no call shape
 *     in this contract that returns more than one workspace's binding, and no
 *     call shape that takes a workspace id as its lookup key.
 *
 * A single trusted secret that could fetch any workspace's decrypted keys would
 * be the highest-value credential in the system, and one log line, one env
 * dump, or one compromised deploy would be every customer's bucket keys at
 * once. Do not put it back.
 *
 * ----------------------------------------------------------------------------
 * PRESENTED TOKENS GO VERBATIM; MINTED TOKENS GO AS HASHES
 * ----------------------------------------------------------------------------
 *
 * One rule, applied consistently, and the asymmetry is deliberate:
 *
 *   - A token **someone presented to us** (an access token on an MCP request, a
 *     refresh token at the token endpoint, a token at the revocation endpoint)
 *     is forwarded **verbatim** over TLS. Convex hashes it on arrival and
 *     compares. Sending a hash instead would make the *stored* hash a working
 *     credential: a database dump plus the gateway secret would then be enough
 *     to impersonate every connected client. Sending the raw token means a dump
 *     of the grants table is inert.
 *   - A token **we just minted** and are asking Convex to remember is sent as
 *     its SHA-256 hash. The plaintext exists in the response to the client and
 *     nowhere else, so we structurally cannot "just email you your token".
 *
 * Convex MUST NOT log a forwarded token, MUST NOT store it in the clear, and
 * MUST hash it immediately on arrival.
 *
 * Every response is `200` with a JSON object, or a refusal. There are no
 * partial successes and no 3xx. A `null` payload means "nothing matched" and is
 * always safe to surface as a generic refusal; it never distinguishes
 * "does not exist" from "not yours". Anything that is not a 200 with parseable
 * JSON of the documented shape raises `ControlPlaneError`, and every caller in
 * this worker turns that into a refusal — never a fallback to another store.
 *
 * ----------------------------------------------------------------------------
 * 1. POST /gateway/session — resolve an access token to a session
 * ----------------------------------------------------------------------------
 * request:
 *   { "accessToken": "<the bearer token exactly as the client presented it>" }
 *
 * Verbatim, per the rule above: Convex hashes on arrival and looks the grant up
 * by that hash. A dump of the grants table therefore contains no working
 * credential, and the gateway secret alone opens nothing.
 *
 * response 200:
 *   { "session": {
 *       "grantId":         "<opaque string>",
 *       "clientId":        "<opaque string — the OAuth client, i.e. which AI app>",
 *       "actorUserId":     "<opaque string — the human this grant acts as>",
 *       "scopes":          ["context:read", "context:write"],
 *       "expiresAt":       1756070000000,          // epoch ms; access-token expiry
 *       "defaultWorkspaceId": "<workspaceId>",
 *       "workspaces": [
 *         { "workspaceId": "<id>", "slug": "seyi", "role": "owner" }
 *       ]
 *   } }
 *
 * or, for an unknown / revoked / expired token, a grant whose user is no longer
 * a member, or a client that has been removed:
 *   { "session": null }
 *
 * `workspaces` is the *set* of contexts this grant reaches. It has one member
 * today. It is a list because the workspace model says a session resolves to a
 * set, and because the `/@slug/mcp` path form selects within it.
 *
 * `role` is per-workspace and is the membership role — `owner` | `editor` |
 * `member`. The control plane MUST NOT return a workspace the grant does not
 * cover, and MUST re-check membership at resolution time so that removing
 * someone from a shared context cuts off their already-issued clients.
 *
 * The control plane SHOULD stamp `lastUsedAt` on the grant here. It MUST NOT
 * fail the resolution if that write fails.
 *
 * ----------------------------------------------------------------------------
 * 2. POST /gateway/binding — fetch a workspace's storage binding
 * ----------------------------------------------------------------------------
 * request:
 *   { "accessToken":        "<the same bearer token, verbatim>",
 *     "expectedWorkspaceId": "<id the gateway believes this is>" | null }
 *
 * **`accessToken` is the authority. `expectedWorkspaceId` is not.** The control
 * plane MUST:
 *
 *   1. validate the gateway secret;
 *   2. **independently** resolve `accessToken` to a live grant — its own hash,
 *      its own index, its own membership re-check, owing nothing to whatever
 *      the gateway concluded a moment ago;
 *   3. derive the workspace from *that grant*;
 *   4. if `expectedWorkspaceId` is non-null and is not the workspace the grant
 *      names, return `{ "binding": null }` — never the requested one, never the
 *      grant's one silently substituted;
 *   5. return the binding for the grant's workspace.
 *
 * Step 4 is a mismatch *check*, not a lookup. There must be no code path in
 * which `expectedWorkspaceId` selects the row. If a future refactor makes the
 * gateway able to name the workspace it gets, the two-factor property is gone
 * and a compromised gateway can walk the customer list.
 *
 * The gateway checks the returned workspace against its own resolution too, so
 * a cross-tenant bug has to defeat two independent checks written against two
 * different resolutions of the same token, rather than one.
 *
 * response 200, credentialed binding (the normal case):
 *   { "binding": {
 *       "workspaceId":     "<the workspace THE GRANT names>",
 *       "provider":        "r2" | "s3" | "b2" | "s3-compatible",   // required; no default
 *       "endpoint":        "https://<account>.r2.cloudflarestorage.com",
 *       "region":          "auto",
 *       "bucket":          "my-context",
 *       "rootPrefix":      "context/",        // optional; "" or absent = bucket root
 *       "accessKeyId":     "<id>",
 *       "secretAccessKey": "<secret>",        // radioactive: sign with it, never log it
 *       "forcePathStyle":  true,              // optional; see S3Store
 *       "capabilities":    { "conditionalWrite": true },
 *       "status":          "active"
 *   } }
 *
 * response 200, native binding (self-hosting only — see `nativeStore`):
 *   { "binding": {
 *       "workspaceId":  "<the workspace THE GRANT names>",
 *       "provider":     "r2-binding",
 *       "bindingName":  "CONTEXT_BUCKET",     // a Worker binding name, not a bucket name
 *       "rootPrefix":   "context/",           // optional
 *       "capabilities": { "conditionalWrite": true },
 *       "status":       "active"
 *   } }
 *
 * response 200, Dropbox binding (the one-click tier):
 *   { "binding": {
 *       "workspaceId":  "<the workspace THE GRANT names>",
 *       "provider":     "dropbox",
 *       "accessToken":  "<short-lived>",      // radioactive: use it, never log it
 *       "rootPrefix":   "context/",           // optional; the folder the customer chose
 *       "capabilities": { "conditionalWrite": true },
 *       "status":       "active"
 *   } }
 *
 * **A Dropbox binding has no endpoint, region, bucket, or key pair, and every
 * one of those fields is absent rather than empty.** The gateway builds a store
 * from the fields its `provider` names and refuses a binding carrying a
 * credential that provider cannot use — so the control plane must *select* the
 * fields for the provider rather than spreading a storage row that may still
 * hold an S3 key from before a rebind. See `src/store/factory.js`.
 *
 * ----------------------------------------------------------------------------
 * THE REFRESH TOKEN NEVER CROSSES THIS BOUNDARY
 * ----------------------------------------------------------------------------
 *
 * Dropbox's long-lived credential is its refresh token: it mints access tokens
 * for as long as the customer leaves the connection in place. **The control
 * plane keeps it and sends the gateway a short-lived access token only**,
 * refreshing when the stored one is within 60s of expiry and persisting the new
 * pair before answering.
 *
 * Same reasoning as "never cache a decrypted credential across requests": a
 * compromised gateway then yields minutes of one workspace's storage, rather
 * than the ability to mint tokens for that workspace forever. There is no field
 * in this response for a refresh token, and a binding carrying anything
 * refresh-shaped is refused outright rather than ignored — a bug that still
 * works is a bug that reaches production.
 *
 * response 200, no usable binding:
 *   { "binding": null }
 *
 * The **same** `null` covers every one of: no such token, revoked grant, expired
 * token, user no longer a member, storage never bound, storage disconnected,
 * and `expectedWorkspaceId` naming a workspace the grant does not cover —
 * including a workspace that does not exist at all. That list is not laziness.
 * Distinguishing "that workspace isn't yours" from "that workspace doesn't
 * exist" turns this endpoint into a customer-list oracle for anyone holding the
 * gateway secret and one valid token.
 *
 * `status` must be `"active"` for the gateway to build a store. Any other value
 * — `"pending"`, `"failed"`, `"disconnected"` — is treated exactly like `null`.
 *
 * `capabilities.conditionalWrite` is the *probed* capability, not an
 * aspiration. B2 and Wasabi accept `If-Match` and ignore it, so the control
 * plane starts a binding at `false` and only a real probe may turn it on.
 *
 * **This response contains a decrypted secret. It is fetched per request and
 * never cached.** See `session.js` for why.
 *
 * ----------------------------------------------------------------------------
 * 3. POST /gateway/clients/register — RFC 7591 dynamic client registration
 * ----------------------------------------------------------------------------
 * request:
 *   { "clientId":              "<gateway-minted opaque id>",
 *     "clientName":            "Claude",
 *     "redirectUris":          ["https://claude.ai/api/mcp/auth_callback"],
 *     "hashedClientSecret":    "<64 hex>" | null,   // null for a public client
 *     "tokenEndpointAuthMethod": "none" | "client_secret_post",
 *     "grantTypes":            ["authorization_code", "refresh_token"],
 *     "responseTypes":         ["code"],
 *     "scope":                 "context:read context:write",
 *     "applicationType":       "native" | "web" }
 *
 * Idempotent on `clientId`: a client that re-registers after a redeploy updates
 * its row rather than forking into a second identity that orphans its grants.
 *
 * response 200: { "ok": true }
 *
 * ----------------------------------------------------------------------------
 * 4. POST /gateway/clients/get — look up a registered client
 * ----------------------------------------------------------------------------
 * request:  { "clientId": "<id>" }
 * response: { "client": { "clientId", "clientName", "redirectUris": [...],
 *                         "hashedClientSecret": "<64 hex>" | null,
 *                         "tokenEndpointAuthMethod": "none" | "client_secret_post" } }
 *           or { "client": null }
 *
 * ----------------------------------------------------------------------------
 * 5. POST /gateway/authorize/start — park a validated authorization request
 * ----------------------------------------------------------------------------
 * The gateway validates the OAuth request and then gets out of the way: the
 * *human* authenticates against the control plane's own app, not against this
 * worker. The gateway never sees a user session cookie, never sees a password,
 * and never decides who someone is.
 *
 * request:
 *   { "clientId":              "<id>",
 *     "redirectUri":           "https://claude.ai/api/mcp/auth_callback",
 *     "state":                 "<opaque client state>" | null,
 *     "codeChallenge":         "<base64url S256 challenge>",
 *     "codeChallengeMethod":   "S256",
 *     "scope":                 "context:read context:write",
 *     "resource":              "https://mcp.context.lc/mcp" | null,
 *     "requestedWorkspaceSlug": "seyi" | null }
 *
 * response 200:
 *   { "requestId":  "<opaque id>",
 *     "consentUrl": "https://app.context.lc/authorize?request_id=<id>" }
 *
 * The gateway 302s the browser to `consentUrl` and its involvement ends until
 * the token call. `consentUrl` MUST be https and MUST be on an origin the
 * control plane owns; the gateway re-checks that before redirecting.
 *
 * After the person signs in, picks a workspace, and approves, the control plane
 * mints an authorization code bound to `{ requestId, workspaceId, userId }` and
 * redirects the browser to the stored `redirectUri` with `code` and `state`.
 * The code MUST be single-use, MUST expire within 10 minutes, and MUST carry
 * the `codeChallenge` forward unchanged.
 *
 * ----------------------------------------------------------------------------
 * 6. POST /gateway/codes/consume — atomically spend an authorization code
 * ----------------------------------------------------------------------------
 * request:  { "code": "<opaque>", "clientId": "<id>" }
 *
 * The control plane MUST mark the code consumed in the same transaction that
 * reads it, so two concurrent calls cannot both succeed. It returns the record
 * once and `null` forever after — including when the same code is replayed a
 * millisecond later, and including when the code is expired or was minted for a
 * different client. PKCE is verified by the gateway *after* this call, so a
 * wrong verifier still burns the code. That is deliberate: RFC 6749 §4.1.2
 * wants a misused code dead, not retryable.
 *
 * response 200:
 *   { "authorization": {
 *       "clientId":            "<id>",
 *       "redirectUri":         "https://claude.ai/api/mcp/auth_callback",
 *       "codeChallenge":       "<base64url>",
 *       "codeChallengeMethod": "S256",
 *       "scope":               "context:read context:write",
 *       "resource":            "https://mcp.context.lc/mcp" | null,
 *       "workspaceId":         "<id>",
 *       "userId":              "<id>"
 *   } }
 *   or { "authorization": null }
 *
 * ----------------------------------------------------------------------------
 * 7. POST /gateway/grants/create — a grant at the end of a successful exchange
 * ----------------------------------------------------------------------------
 * request:
 *   { "workspaceId":          "<id>",
 *     "userId":               "<id>",
 *     "clientId":             "<id>",
 *     "scopes":               ["context:read", "context:write"],
 *     "hashedRefreshToken":   "<64 hex>",
 *     "hashedAccessToken":    "<64 hex>",
 *     "accessTokenExpiresAt": 1756070000000 }
 *
 * The control plane re-checks membership here too: an authorization code can
 * outlive the moment it was issued, and someone removed from a workspace in
 * between must not end up holding a working grant to it.
 *
 * response 200: { "grantId": "<id>" }
 *
 * ----------------------------------------------------------------------------
 * 8. POST /gateway/grants/rotate — refresh, with mandatory rotation
 * ----------------------------------------------------------------------------
 * request:
 *   { "refreshToken":           "<verbatim — the token the client presented>",
 *     "clientId":               "<id>",
 *     "newHashedRefreshToken":  "<64 hex>",
 *     "newHashedAccessToken":   "<64 hex>",
 *     "accessTokenExpiresAt":   1756070000000,
 *     "scopes":                 ["context:read"] | null }   // narrowing only
 *
 * Atomic: resolve, verify `active` and that `clientId` matches the grant, then
 * replace both hashes in one transaction.
 *
 * OAuth 2.1 §4.3.1 requires rotation for public clients, which means reuse
 * detection is not optional: **if the presented refresh token hashes to a
 * grant's *previous* hash rather than its current one, the control plane MUST
 * revoke the grant and return `null`.** A replayed refresh token means the
 * token leaked; keeping the grant alive would keep the thief alive with it.
 *
 * response 200: { "grant": { "grantId", "workspaceId", "userId", "clientId",
 *                            "scopes": [...] } } or { "grant": null }
 *
 * ----------------------------------------------------------------------------
 * 9. POST /gateway/grants/revoke — RFC 7009
 * ----------------------------------------------------------------------------
 * request:  { "token": "<verbatim — the token the client presented>",
 *             "tokenType": "access" | "refresh", "clientId": "<id>" }
 * response: { "revoked": true | false }
 *
 * Revokes exactly one grant — the one that token belongs to — and touches
 * nothing else. Sibling grants (same user, same workspace, different AI client)
 * keep working; that is the entire point of per-client grants. RFC 7009 says
 * the endpoint answers 200 whether or not anything matched, so the gateway
 * discards `revoked` for the client's benefit and keeps it only for tests.
 *
 * The control plane MUST refuse to revoke a grant belonging to a different
 * `clientId` than the one authenticating the revocation request.
 *
 * ============================================================================
 */

/** How long a control-plane call may take before the gateway gives up. */
const CONTROL_PLANE_TIMEOUT_MS = 8_000;

/**
 * Cap on a control-plane response body.
 *
 * Small on purpose: every documented payload is a few hundred bytes, and the
 * gateway has no reason to buffer more from anything, including a service it
 * trusts. A trusted service having a bad day is still a way to exhaust a
 * Worker.
 */
const CONTROL_PLANE_RESPONSE_BYTE_CAP = 256_000;

/**
 * A control-plane call did not produce a usable answer.
 *
 * Carries a short reason for the gateway's own structured logs and nothing
 * else. It never carries the response body, the gateway secret, a token hash,
 * a workspace id, or a storage credential — an error string is the easiest
 * place in a system for a secret to escape, and this is the type that would
 * carry it.
 */
export class ControlPlaneError extends Error {
  constructor(reason) {
    super(`control plane unavailable: ${reason}`);
    this.name = "ControlPlaneError";
    this.reason = reason;
  }
}

/** SHA-256 of a string, lowercase hex — the only form a token reaches Convex in. */
export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Loopback hosts, in the spellings `URL` produces.
 *
 * Lives here rather than in `oauth.js` because that module already imports from
 * this one; the reverse would be a cycle. Shared so "http is only ever
 * acceptable to this machine" is stated once instead of drifting between the
 * redirect-URI rules, the consent-URL check, and the control-plane URL check.
 */
export function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
}

function requireConfig(env) {
  const base = typeof env?.CONTROL_PLANE_URL === "string" ? env.CONTROL_PLANE_URL.trim() : "";
  const secret = typeof env?.GATEWAY_SECRET === "string" ? env.GATEWAY_SECRET : "";
  if (!base || !secret) {
    // Deliberately vague and deliberately fatal. A gateway with no control
    // plane has no tenants; it must refuse every request rather than degrade
    // into some other access path.
    throw new ControlPlaneError("not configured");
  }
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new ControlPlaneError("not configured");
  }
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    // Every response on this channel can carry a decrypted storage secret, so
    // it must be encrypted in transit. The exception is loopback, for a control
    // plane running on the same machine during development — it cannot leave
    // the host. This used to exempt the literal hostname `control-plane.test`
    // instead, which put a cleartext carve-out for one specific name into a
    // production code path that no deployment could turn off; the test double
    // is https and never needed it.
    throw new ControlPlaneError("not configured");
  }
  return { base: base.replace(/\/+$/, ""), secret };
}

/**
 * A typed client for the contract above.
 *
 * Constructed per request. It holds the gateway secret in memory for the life
 * of one call and nothing else — no connection pool, no memo, no module-level
 * state that a reused isolate could carry into the next tenant's request.
 */
export function createControlPlane(env, options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));

  async function post(path, body) {
    const { base, secret } = requireConfig(env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTROL_PLANE_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: {
          // The secret appears here and nowhere else in the process.
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // "manual", not "error". workerd does not implement `redirect: "error"`
        // — fetch rejects with a TypeError before the request is made, and the
        // catch below flattens that to "request failed", so every control-plane
        // call fails identically and invisibly. This is the same defect that
        // stopped the email worker dead; see infra/email-worker/src/controlPlane.ts.
        //
        // "manual" keeps the intent: a redirect is surfaced as a response rather
        // than followed, and the status check below refuses anything that is not
        // a 200 — so no credential is replayed to a Location we did not choose.
        redirect: "manual",
      });
    } catch {
      // The caught error may quote the request — headers included. It is
      // dropped on the floor rather than wrapped.
      throw new ControlPlaneError("request failed");
    } finally {
      clearTimeout(timer);
    }

    if (!response || response.status !== 200) {
      // Status only. A control-plane error body is not something this worker
      // relays: it is written for operators, and the caller is an AI client on
      // the internet.
      throw new ControlPlaneError(`status ${response?.status ?? "none"}`);
    }
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > CONTROL_PLANE_RESPONSE_BYTE_CAP) {
      throw new ControlPlaneError("response too large");
    }
    let text;
    try {
      text = await response.text();
    } catch {
      throw new ControlPlaneError("response unreadable");
    }
    if (text.length > CONTROL_PLANE_RESPONSE_BYTE_CAP) {
      throw new ControlPlaneError("response too large");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ControlPlaneError("response not json");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ControlPlaneError("response not an object");
    }
    return parsed;
  }

  /**
   * Read one documented key out of a response, insisting the key was actually
   * present.
   *
   * The difference between `null` and `undefined` is load-bearing here. An
   * explicit `null` is the contract's "nothing matched" and is a clean refusal.
   * A *missing* key is a control plane that answered something other than what
   * this file documents — a version skew, a proxy, a wrong URL — and must not
   * be read as "nothing matched", because the same laxness would read a
   * `{"binding": undefined}` as "no binding" when the real answer might have
   * been a binding for the wrong tenant.
   */
  function required(parsed, key) {
    if (!(key in parsed)) throw new ControlPlaneError(`response missing ${key}`);
    return parsed[key];
  }

  return {
    /**
     * @param {string} accessToken the bearer token exactly as presented
     * @returns {Promise<object|null>} the session, or null for no live grant.
     */
    async resolveSession(accessToken) {
      return required(await post("/gateway/session", { accessToken }), "session");
    },

    /**
     * Fetch the storage binding for the workspace **the user's token names**.
     *
     * `expectedWorkspaceId` is the gateway's own independent conclusion, sent
     * so the control plane can refuse a mismatch. It is not a lookup key and
     * the control plane must not treat it as one — see the contract above.
     *
     * @returns {Promise<object|null>} the binding with its secret opened, or null.
     */
    async getStorageBinding(accessToken, expectedWorkspaceId) {
      return required(
        await post("/gateway/binding", { accessToken, expectedWorkspaceId }),
        "binding"
      );
    },

    async registerClient(registration) {
      const parsed = await post("/gateway/clients/register", registration);
      if (required(parsed, "ok") !== true) throw new ControlPlaneError("registration refused");
      return true;
    },

    async getClient(clientId) {
      return required(await post("/gateway/clients/get", { clientId }), "client");
    },

    async startAuthorization(request) {
      const parsed = await post("/gateway/authorize/start", request);
      const requestId = required(parsed, "requestId");
      const consentUrl = required(parsed, "consentUrl");
      if (typeof requestId !== "string" || typeof consentUrl !== "string") {
        throw new ControlPlaneError("malformed authorization start");
      }
      return { requestId, consentUrl };
    },

    async consumeAuthorizationCode(code, clientId) {
      return required(await post("/gateway/codes/consume", { code, clientId }), "authorization");
    },

    async createGrant(grant) {
      const grantId = required(await post("/gateway/grants/create", grant), "grantId");
      if (typeof grantId !== "string" || !grantId) {
        throw new ControlPlaneError("malformed grant id");
      }
      return grantId;
    },

    async rotateGrant(rotation) {
      return required(await post("/gateway/grants/rotate", rotation), "grant");
    },

    async revokeGrant(token, tokenType, clientId) {
      return required(
        await post("/gateway/grants/revoke", { token, tokenType, clientId }),
        "revoked"
      );
    },

    /**
     * Tell the control plane that some counted things happened.
     *
     * **The only call on this client whose failure is nobody's problem.** Every
     * other method resolves a session, opens a credential or moves a grant, and
     * a failure there is a failed request. This one moves a number on an
     * operator's dashboard, so it is called behind the response and its
     * rejection is swallowed at the call site — a search that worked but was
     * not counted is a good outcome, and a search that failed because the
     * counter was down is not.
     *
     * **What crosses is a name and a number.** `events` carries a metric name
     * from the control plane's closed vocabulary and an optional workspace id
     * this gateway just resolved a grant to. There is no field here for a
     * path, a query, a note title or a timestamp, and there must never be one:
     * what a person searched for is theirs, and their own audit trail — in
     * their own bucket — is where a record of it legitimately lives.
     *
     * @param {{metric: string, workspaceId?: string, count?: number}[]} events
     */
    async reportUsage(events) {
      if (!Array.isArray(events) || events.length === 0) return { applied: 0 };
      return await post("/gateway/usage", { events });
    },
  };
}
