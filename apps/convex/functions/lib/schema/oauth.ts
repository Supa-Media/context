import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * MCP OAuth clients, parked authorizations, per-client grants, and Dropbox's
 * connect round trip.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const oauthTables = {
  /**
   * MCP clients registered dynamically (RFC 7591). A client is a piece of
   * software, not a person and not a tenant — it grants nothing on its own.
   * Authority lives in `oauthGrants`.
   */
  oauthClients: defineTable({
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    /** `null` for public clients (PKCE, no secret to store). */
    hashedClientSecret: v.union(v.string(), v.null()),
    /**
     * How the client proves who it is at the token endpoint.
     *
     * Stored rather than inferred from `hashedClientSecret === null`, because
     * the two can disagree and the disagreement is the interesting case: a
     * client that registered `none` but somehow acquired a stored secret must
     * still be treated as public, and a client that registered
     * `client_secret_post` and has no stored secret is broken rather than
     * silently public. RFC 7591's `client_secret_basic` is normalized to
     * `client_secret_post` by the gateway before it reaches here — one
     * credential-presentation path is one path to get wrong.
     *
     * Optional only because rows written before this field existed predate the
     * gateway flow entirely; readers fall back to the `hashedClientSecret`
     * shape.
     */
    tokenEndpointAuthMethod: v.optional(
      v.union(v.literal("none"), v.literal("client_secret_post")),
    ),
    /**
     * The rest of the RFC 7591 registration, kept because a re-registration
     * after a redeploy must be able to reproduce what the client asked for.
     * None of it is authority: the gateway enforces grant types and response
     * types itself, and `scope` here is a request, not a grant.
     */
    grantTypes: v.optional(v.array(v.string())),
    responseTypes: v.optional(v.array(v.string())),
    scope: v.optional(v.string()),
    applicationType: v.optional(v.union(v.literal("native"), v.literal("web"))),
    /**
     * RFC 7591's `software_id`: what the client says it *is*, as opposed to
     * what it called itself this time.
     *
     * **Client-asserted, and nothing here pretends otherwise.** Registration is
     * unauthenticated by construction, so anything that can register can claim
     * any string. It is stored because one reader needs it —
     * `approveOwnMachineGrant`, which mints the desktop shell's machine grant
     * with no approve screen and refuses to do that for a client that did not
     * declare itself the shell. That check is a *scope* on a convenience, never
     * an authentication: what actually bounds the convenience is that the code
     * can only be delivered to a loopback listener on the person's own machine
     * and the grant is exactly the default scope. See
     * `functions/lib/machineGrant.ts`.
     *
     * Optional: every client registered before this field existed has none, and
     * absent is refused by the one reader, which is the safe direction.
     */
    softwareId: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_clientId", ["clientId"]),

  /**
   * An authorization request parked by the gateway, and — once a human has
   * approved it — the single-use code that closes the flow.
   *
   * **One row, two phases, on purpose.** The alternative is a `requests` table
   * and a `codes` table, and then "the code carries the challenge forward
   * unchanged" is a join that a future refactor can get wrong. Here the code
   * cannot exist apart from the request that produced it, and the PKCE
   * challenge the gateway will verify against is the same field the gateway
   * wrote when it parked the request.
   *
   * `hashedCode` is a hash, not the code. The plaintext exists in the redirect
   * that carried it to the client and nowhere else — the same rule the grants
   * table follows, for the same reason: a dump of this table must not be a set
   * of spendable codes.
   *
   * `status` is what makes redemption single-use. `consume` moves `approved` →
   * `consumed` in the same transaction that reads the row, so two concurrent
   * redemptions cannot both see `approved`.
   */
  oauthAuthorizations: defineTable({
    /** Opaque, high-entropy, and the only handle on this row. */
    requestId: v.string(),
    clientId: v.string(),
    /** Exactly the URI the flow started with. Re-checked at the token call. */
    redirectUri: v.string(),
    state: v.union(v.string(), v.null()),
    codeChallenge: v.string(),
    /** S256 only. `plain` makes the challenge the verifier, which is no PKCE at all. */
    codeChallengeMethod: v.literal("S256"),
    /**
     * What the client **asked for**. A request, never a grant.
     *
     * Kept after approval rather than overwritten, because "what was asked" and
     * "what was given" are different facts, and an audit trail that cannot tell
     * them apart cannot show that a person narrowed anything.
     */
    scope: v.string(),
    /**
     * What the person **actually approved**, space-delimited.
     *
     * Written by `applyApproval` and by nothing else, already narrowed to the
     * request and already clamped to what the approver's role could hand over.
     * This is the field the token exchange reads, so a scope the person
     * unticked is a scope no grant ever carries.
     *
     * Optional only because a row that has not been approved yet has no answer.
     * An `approved` row without it can only be one parked before this field
     * existed — at most one authorization window old, since a request lives ten
     * minutes — and `consumeAuthorizationCode` falls back to `scope` for those.
     * That fallback cannot widen anything: `context:private` was not a grantable
     * scope when such a row was written, so the widest thing it reconstructs is
     * the old read/write pair, at `team` tier.
     */
    grantedScope: v.optional(v.string()),
    resource: v.union(v.string(), v.null()),
    /** A preselection hint for the consent screen. The person still chooses. */
    requestedWorkspaceSlug: v.union(v.string(), v.null()),
    /**
     * `pending` → `approved` → `consumed` is the happy path; `pending` →
     * `denied` is the person saying no.
     *
     * `denied` is a distinct terminal state rather than a reuse of `consumed`
     * because the two mean opposite things — one produced a code that was
     * spent, the other produced no code at all — and an audit trail that cannot
     * tell "the user refused" from "the client redeemed" is not worth keeping.
     * Everything downstream already fails closed on it: the consent screen
     * shows only `pending`, and `consumeAuthorizationCode` requires `approved`.
     */
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("consumed"),
      v.literal("denied"),
    ),
    /** SHA-256 of the authorization code. Set when a person approves. */
    hashedCode: v.optional(v.string()),
    /** The workspace the person picked. Never something the gateway named. */
    workspaceId: v.optional(v.id("workspaces")),
    /** The person who approved. Never something the gateway named. */
    userId: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    consumedAt: v.optional(v.number()),
    /** When the person refused. Set with `status: "denied"`, and only then. */
    deniedAt: v.optional(v.number()),
    /** Both phases expire. RFC 6749 §4.1.2 wants a code dead within 10 minutes. */
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_requestId", ["requestId"])
    .index("by_hashedCode", ["hashedCode"])
    /**
     * For the sweep, and for nothing else.
     *
     * An expired row is inert — every reader checks `expiresAt` — but inert is
     * not the same as gone, and this table grows by one row per authorization
     * attempt forever. The cron in `crons.ts` walks this index; without it the
     * sweep would be a full table scan of the thing it is trying to keep small.
     */
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * One row per connected AI client, per user, per workspace — individually
   * revocable. Revoking ChatGPT must not log Claude out, which is why the
   * grant, not the user session, is the unit of authority.
   */
  /**
   * A Dropbox connect that has been started and not yet answered.
   *
   * ## Why this table exists at all
   *
   * The OAuth redirect comes back through the customer's browser, which means
   * the only thing tying the returned code to the flow that started it is a
   * value we minted and can recognise. Without one, an attacker completes
   * *their own* Dropbox authorization, hands the victim the resulting callback
   * URL, and the victim's context is bound to storage the attacker controls —
   * silently, and permanently. Every note the victim writes then lands
   * somewhere else. That is worse than a leaked token, and it is the reason
   * this is a row rather than a query parameter.
   *
   * ## What is stored, and in what form
   *
   * `hashedState` is a digest, not the value: the raw `state` travels in a URL
   * and lands in browser history, a referrer header, and possibly a proxy log,
   * so the copy at rest is the one that must not be usable if this table
   * leaks. Same reasoning as `oauthGrants.hashedRefreshToken`.
   *
   * `encryptedVerifier` is encrypted rather than hashed, because unlike a
   * token it has to be *replayed* to Dropbox at the exchange. It is the whole
   * proof of PKCE and it **never goes to the browser** — the client asks for a
   * URL and gets only a URL.
   *
   * `workspaceId` and `startedBy` are what make the callback verifiable as the
   * same person's flow, not merely a well-formed one.
   */
  dropboxConnectAttempts: defineTable({
    /** SHA-256 of the state value. The raw value exists only in the URL. */
    hashedState: v.string(),
    /**
     * SHA-256 of a second value that **never travels through Dropbox**.
     *
     * `state` goes out in the authorize URL and comes back in the callback, so
     * whoever built the URL knows it — including somebody who built it for
     * their own workspace and sent it to another person. This is the value
     * that separates those two: minted at start, returned to the starting
     * browser alone, kept there, and required back at completion. It is what
     * makes `state` browser-bound in the sense RFC 6749 §10.12 means, without
     * a session — `#76` removed the session gate on the callback for a real
     * reason and this must not reintroduce one.
     *
     * Optional only because attempts parked before it existed have none, and
     * those are refused rather than trusted.
     */
    hashedCompletion: v.optional(v.string()),
    /** The PKCE verifier, sealed with the workspace id as AAD. */
    encryptedVerifier: v.string(),
    workspaceId: v.id("workspaces"),
    startedBy: v.id("users"),
    /** The redirect the flow was started for; the exchange must reuse it. */
    redirectUri: v.string(),
    /** The folder the person chose, carried across the redirect. */
    rootPrefix: v.optional(v.string()),
    /**
     * Where the person was when they left, carried across the redirect.
     *
     * The redirect destroys the page that started it, and the redirect URI
     * cannot carry this — Dropbox matches it exactly. Without it, connecting
     * Dropbox during first-run navigated away mid-flow and the welcome gate
     * then routed the returning owner to the console: the layout and agents
     * steps simply never happened. Seen on the first live run.
     */
    resumeTo: v.optional(v.literal("onboarding")),
    /**
     * Short. An authorization that has not come back within a few minutes is a
     * tab somebody abandoned, and a parked verifier is a live half-credential
     * — there is no reason to keep one for a day.
     */
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_hashed_state", ["hashedState"])
    .index("by_expiresAt", ["expiresAt"]),

  oauthGrants: defineTable({
    /** Ephemeral first-party browser instance; never an authorization credential. */
    consoleInstanceId: v.optional(v.string()),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    clientId: v.string(),
    /**
     * Exactly what the person approved — **including the privacy tier**.
     *
     * `context:private` here is the only record that this client may reach
     * notes marked private, and its absence is the only record that it may not.
     * There is deliberately no separate `visibilityTier` column: a tier stored
     * twice is a tier that can disagree with itself, and the direction that
     * disagreement fails is "an AI client reads more than the person allowed".
     * The gateway derives the tier from this array on every request rather than
     * from the approver's role, so an owner who granted `team` keeps `team`
     * forever. See `functions/lib/consentScopes.ts`.
     *
     * A grant written before the tier was grantable carries no
     * `context:private`, and therefore resolves to `team`. Fail-closed: a
     * legacy row narrows rather than keeping the widest tier by default.
     */
    scopes: v.array(v.string()),
    /** Hash only. A raw refresh token never touches this database. */
    hashedRefreshToken: v.string(),
    /**
     * Hash only, same rule. This is what an inbound MCP request is resolved
     * by: the gateway forwards the bearer token the client presented, verbatim
     * over TLS, and it is hashed here on arrival.
     *
     * The direction is deliberate and it is the reason a dump of this table is
     * inert. If the gateway sent the *hash* instead, the stored value would be
     * a working credential and one database leak plus the gateway secret would
     * impersonate every connected client.
     *
     * Optional because grants written before the access-token flow existed
     * have none — and a grant with no access-token hash simply never resolves
     * an inbound request, which is the correct fail-closed behaviour.
     */
    hashedAccessToken: v.optional(v.string()),
    /** Epoch ms. A grant whose access token has expired resolves to nothing. */
    accessTokenExpiresAt: v.optional(v.number()),
    /**
     * The refresh-token hash this grant most recently rotated away from.
     *
     * OAuth 2.1 §4.3.1 makes rotation mandatory for public clients, which
     * makes reuse detection mandatory too: a refresh token presented twice is
     * a refresh token that leaked. Keeping one generation of history is what
     * lets `rotateGrant` tell "an unknown token" (refuse) from "a token this
     * grant already retired" (refuse **and** revoke the grant, because
     * somebody else is holding it).
     */
    previousHashedRefreshToken: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("revoked")),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"])
    .index("by_workspace_user", ["workspaceId", "userId"])
    .index("by_refresh_token", ["hashedRefreshToken"])
    .index("by_access_token", ["hashedAccessToken"])
    .index("by_previous_refresh_token", ["previousHashedRefreshToken"]),
};
