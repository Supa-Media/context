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
 * 1a. POST /gateway/sessions/by-grant — re-check a room's current members
 * ----------------------------------------------------------------------------
 * request:
 *   { "expectedWorkspaceId": "<workspaceId>",
 *     "grantIds": ["<opaque grant id>", ...] } // unique, at most 24
 *
 * This is authorization metadata only. It returns no token, storage binding,
 * person or client identity, privacy rule, path, or note content. Rows are
 * aligned with the request and a stale or invalid grant is `null`.
 *
 * response 200:
 *   { "sessions": [
 *       { "grantId", "workspaceId", "scopes", "role", "kind",
 *         "grantedNames"?: ["group-name"] } | null,
 *       ...
 *   ] }
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
 * 2a. THE OPTIONAL `searchIndex` SIBLING — fast search, where it is on
 * ----------------------------------------------------------------------------
 *
 * A binding MAY carry one more object beside the storage fields:
 *
 *   "searchIndex": {
 *       "databaseId": "<d1 uuid>",
 *       "accountId":  "<cloudflare account id>",
 *       "apiToken":   "<d1 write token>",   // radioactive: as secretAccessKey
 *       "state":      "backfilling" | "ready"
 *   }
 *
 * **Absent means fast search is off for this workspace, which is the normal
 * case and not an error.** Off-by-default is the decision, and the R2 shard
 * index serves the search exactly as it does today — `docs/decisions/search.md`
 * calls that a working state rather than a degraded one, which is the whole
 * reason the feature could ship off. So the gateway treats an absent, partial
 * or malformed descriptor identically: serve from R2, project nothing.
 *
 * `apiToken` gets the treatment `secretAccessKey` gets, and for the same
 * reason: it appears in one `Authorization` header in `search/d1/client.js`
 * and nowhere else. Never logged, never in an error message, never returned to
 * a caller, never written to a bucket. `search/d1/client.js` classifies every
 * provider failure into a closed set of codes rather than relaying the
 * provider's text, because that text can name an account or a database.
 *
 * The control plane MUST NOT send this object for a workspace whose owner has
 * not opted in, and MUST stop sending it the moment they opt out — search
 * falls back to R2 on the next request, which is what makes the switch a
 * switch rather than a deletion job.
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
 * `capabilities.conditionalWrite`, `capabilities.conditionalCreate`,
 * `capabilities.conditionalDelete`, and `capabilities.serverSideCopy` are
 * *probed* capabilities, not aspirations. B2 and Wasabi accept conditional
 * headers and ignore some of them, so the control plane starts a binding at
 * `false` and only a real probe may turn it on.
 *
 * **This response contains a decrypted secret. It is fetched per request and
 * never cached.** See `session.js` for why.
 *
 * ----------------------------------------------------------------------------
 * 2c. POST /gateway/provider — fetch a workspace's model account
 * ----------------------------------------------------------------------------
 * request:
 *   { "accessToken":         "<the same bearer token, verbatim>",
 *     "expectedWorkspaceId": "<id the gateway believes this is>" | null,
 *     "provider":            "anthropic" | "openai" }
 *
 * response 200:
 *   { "credential": { "provider": "anthropic", "apiKey": "<the key>" } }
 *   { "credential": null }
 *
 * The customer connects their own Anthropic or OpenAI account and the agent
 * spends it — their bill, no markup, nothing a cancellation of ours could
 * strand. So this response carries a credential, and every rule route 2 states
 * applies here word for word: the gateway secret first, an independent
 * resolution of `accessToken` to a live grant second, the workspace derived
 * from *that grant*, and `expectedWorkspaceId` selecting only within the set
 * that grant covers. There must be no code path in which it selects a row.
 *
 * **Everything that is not a hit is `{ "credential": null }`** — an unknown
 * token, an expired or revoked grant, a workspace outside the set, a provider
 * this build does not know, a provider nobody connected, and a decrypt that
 * failed. A caller must not be able to tell those apart; in particular the
 * provider set must not be enumerable by asking.
 *
 * **Two flat fields, and nothing beside them.** No workspace id, no
 * fingerprint, no grant id. That is not tidiness: #661 was a `v.object` whose
 * shape drifted, and the validation error serialized everything the object
 * carried — including a live storage secret — into the production logs. A
 * response shape with nothing in it but the credential is one that cannot
 * spill a second thing.
 *
 * It is a route rather than another sibling on route 2 for the same reason.
 * `searchIndex`, `encryptionKey` and `rotation` all became siblings there to
 * avoid opening a new door; a model key folded in would share a returns
 * validator with `secretAccessKey`, so one drift could spill both. It also
 * means the key is opened only by the request that is about to spend it, not
 * on every ordinary MCP call.
 *
 * **This response contains a decrypted secret. It is fetched per request and
 * never cached.**
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
 * ----------------------------------------------------------------------------
 * 10. POST /gateway/search-index/progress — how far the projection has got
 * ----------------------------------------------------------------------------
 * request:
 *   { "workspaceId":  "<id this request already resolved a grant to>",
 *     "notesIndexed": 412,
 *     "notesPending": 88,
 *     "state":        "ready",        // optional; only when nothing is pending
 *     "errorCode":    "UNAUTHORIZED"  // optional; ours, from a closed set
 *   }
 *
 * response 200: anything. The gateway discards the body.
 *
 * The gateway copies notes into the projection (`search/d1/backfill.js`) and
 * therefore is the only thing that knows how far it has got. **It reports
 * counts and never decides policy**: the control plane owns the row, decides
 * what a state transition means, and is free to ignore anything here.
 *
 * Two rules, and both are about what the numbers are *not*:
 *
 *  - **`state` is only ever `"ready"`.** A pass that is still working says
 *    nothing, because the row already says `backfilling` and a gateway
 *    reasserting it every search is a write per search. There is deliberately
 *    no "failed" state on this route — the state vocabulary belongs to the
 *    control plane, and a gateway inventing a word for it would be the
 *    console's "a state this build does not know" case arriving from the wrong
 *    direction.
 *  - **`errorCode` is how a failure is heard.** A projection that cannot reach
 *    its database leaves search working — the R2 index answers — so nothing
 *    else in the system would ever notice, and the workspace would sit at
 *    "Preparing" forever. That was the bug. The code comes from
 *    `search/d1/client.js`'s closed set, never from the provider's text, and
 *    the field name matches `searchIndexes.errorCode` so the row can hold it
 *    unchanged.
 *
 * Like `/gateway/usage`, this is a call whose failure is nobody's problem: it
 * runs behind the response and its rejection is swallowed. A projection that
 * advanced but was not counted is a good outcome.
 *
 * ============================================================================
 */

export * from "./controlPlane/index.js";
