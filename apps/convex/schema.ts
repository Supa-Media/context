import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { supaAuthTables } from "@supa-media/convex/schema";

/**
 * Control-plane schema for Context.
 *
 * METADATA ONLY. Note content lives exclusively in the customer's own bucket
 * (see CLAUDE.md, "The customer owns the storage"). Nothing in this file may
 * ever hold Markdown, note bodies, attachment bytes, or a second copy of
 * anyone's context. If a future table looks like it wants to cache note text,
 * that is the wrong table.
 *
 * ## Why not `supaTenantTables({ tenantName: "workspace" })`
 *
 * The framework's generic tenant tables give `workspaces` + `userWorkspaces`
 * with `slug: v.optional(v.string())`, `role: v.optional(v.string())`, and a
 * `workspaceId: v.string()` foreign key (the helper cannot emit `v.id()` for a
 * table name it only knows at runtime). Context needs the opposite of all
 * three: the slug is *required* and globally unique because it is how a
 * context is addressed (`@name/1-projects/foo.md`), the role is *required*
 * because write access is never implied, and the foreign keys must be real
 * `v.id()` references so a mis-scoped read is a type error rather than a
 * runtime surprise. Those are security properties, not cosmetics, so the
 * tables are declared explicitly here. `supaAuthTables` is still the framework
 * base — only the tenant half diverges. If the framework later grows a tenant
 * helper that can express required slugs and typed ids, this should move back
 * upstream.
 */
const schema = defineSchema({
  ...supaAuthTables,

  /**
   * ONE global namespace shared by usernames and workspace slugs.
   *
   * `@lk` (a person) and `@shared-thing` (a workspace) are addressed
   * identically in `@name/path`, so they cannot be allowed to collide. Keeping
   * both kinds in a single table makes that structural: a claim is a row, and
   * the uniqueness check is one lookup rather than two that could race past
   * each other.
   *
   * `name` is always the normalized form (see `functions/lib/names.ts`).
   */
  names: defineTable({
    name: v.string(),
    kind: v.union(v.literal("user"), v.literal("workspace")),
    /** Set when `kind === "user"`. */
    userId: v.optional(v.id("users")),
    /** Set when `kind === "workspace"`. */
    workspaceId: v.optional(v.id("workspaces")),
    claimedBy: v.id("users"),
    claimedAt: v.number(),
  })
    .index("by_name", ["name"])
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"]),

  /**
   * A workspace is the unit that owns a context: one storage binding, one
   * privacy manifest, one audit trail, one set of grants.
   *
   * A personal context is a workspace with a single `owner` member. A shared
   * context is the same row with more members. There is deliberately no
   * separate "personal context" table — see CLAUDE.md, "The workspace model".
   */
  workspaces: defineTable({
    /** Normalized, globally unique, also present as a row in `names`. */
    slug: v.string(),
    displayName: v.string(),
    createdBy: v.id("users"),
    kind: v.union(v.literal("personal"), v.literal("shared")),
    /**
     * Which folder scaffold the gateway lays down on first connect. Purely a
     * setup hint — the tools operate on paths, not on a fixed taxonomy, and a
     * `custom` workspace is not second-class.
     */
    structureTemplate: v.union(v.literal("para"), v.literal("custom")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  /**
   * Membership carries an explicit role. Read access and write access to
   * someone else's context are different grants; write is never implied.
   *
   * owner  — full control, including storage rebinding and revoking anyone's grant
   * editor — read + write notes
   * member — read only
   */
  workspaceMembers: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")),
    invitedBy: v.optional(v.id("users")),
    joinedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"])
    .index("by_workspace_user", ["workspaceId", "userId"]),

  /**
   * An outstanding offer of membership.
   *
   * ## The invitation is addressed to an identifier, never to a user id
   *
   * `invitee` holds the normalized `@name` or email address exactly as the
   * owner typed it, and it is resolved to a person only when somebody tries to
   * accept. That is not laziness, it is the whole oracle defence: if inviting
   * `@does-not-exist` were handled differently from inviting `@lk` — no row
   * versus a row, or a row carrying a `userId` versus one that does not — then
   * `listInvitations` would tell the inviter which names are real, and an
   * attacker with an account could enumerate the user base by typing names into
   * an invite box. Resolving late also happens to be the correct semantics: an
   * account's email can change, and the invitation should follow whoever holds
   * that address when it is answered, not whoever held it when it was sent.
   *
   * At most one row exists per `(workspaceId, inviteeKind, invitee)`. Re-inviting
   * supersedes the previous row in place, so a person who declined leaves no
   * trace for the next invitation to sit beside — see `functions/invitations.ts`.
   *
   * ## `token` is stored in plaintext, deliberately, and that is not the rule
   * `oauthGrants` follows
   *
   * A refresh token is a bearer credential: whoever holds it *is* the client, so
   * a dump of that table would be a set of working credentials and only a hash
   * may be stored. An invitation token is not a bearer credential. Accepting
   * additionally requires being the addressed identity — holding a name claim or
   * a verified email that matches `invitee` — so possession alone grants
   * nothing, and a dump of this table is inert for anyone who is not already the
   * invitee. What the token buys is that the handle is unguessable and
   * unenumerable: an attacker cannot walk this table by id.
   *
   * Hashing it would buy no confidentiality against an attacker who is already
   * the invitee, and would cost the one delivery channel that exists — the
   * invitee's own `listMyInvitations`, which is how an invitation is answered
   * in-app while nothing here sends email.
   *
   * `role` is `editor` or `member` and structurally cannot be `owner`. Handing
   * over a context is a separate, deliberate act; an invitation must never be
   * able to perform it.
   */
  workspaceInvitations: defineTable({
    workspaceId: v.id("workspaces"),
    /**
     * `name` — a `@handle` out of the shared namespace, stored undecorated.
     * `email` — a lowercased address.
     *
     * Kept as an explicit field rather than derived from the string's shape, so
     * no reader has to guess and no two readers can guess differently.
     */
    inviteeKind: v.union(v.literal("name"), v.literal("email")),
    invitee: v.string(),
    role: v.union(v.literal("editor"), v.literal("member")),
    invitedBy: v.id("users"),
    /** Unguessable, single-use, and useless without the matching identity. */
    token: v.string(),
    /**
     * `pending` is the only status any reader acts on. The others exist so the
     * row is not silently reused: `accepted` and `declined` are terminal, and
     * `revoked` is the owner taking the offer back.
     */
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("revoked"),
    ),
    expiresAt: v.number(),
    createdAt: v.number(),
    respondedAt: v.optional(v.number()),
  })
    /**
     * Pending invitations for one context. There is deliberately no plain
     * `by_workspace` index beside it: nothing needs one, and an unnarrowed
     * listing is the shape this one exists to prevent.
     *
     * `status` is in the key rather than filtered afterwards because the
     * `listInvitations` read is bounded: with a plain `by_workspace` index, a
     * context that has answered a few hundred invitations would fill the
     * bounded window with dead rows and push its live ones out of sight.
     * Narrowing in the index means the bound applies to what is actually being
     * listed.
     */
    .index("by_workspace_status", ["workspaceId", "status"])
    /**
     * Serves two reads with one index: the `(kind, invitee)` prefix finds every
     * context that has invited *you*, and the full triple finds the one row a
     * re-invitation must supersede.
     */
    .index("by_invitee", ["inviteeKind", "invitee", "workspaceId"])
    .index("by_token", ["token"])
    /** For the sweep, and for nothing else — same reasoning as `oauthAuthorizations`. */
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * The customer's bucket credential.
   *
   * KEYED BY `workspaceId`, NEVER `userId`. A binding belongs to the context,
   * not to the person who happened to paste the key — otherwise every shared
   * context becomes a migration instead of a row.
   *
   * `rootPrefix` is optional and is applied at the storage-adapter boundary
   * only. It is NOT tenancy: we never namespace keys inside a customer bucket,
   * so a bucket that already looks like a Context brain connects unchanged.
   *
   * `encryptedSecretAccessKey` is an opaque envelope produced by
   * `functions/lib/crypto.ts` (`v2:<key-id>:<iv-b64>:<ciphertext-b64>`). The
   * plaintext secret is never stored, never returned by a public function, and
   * is decrypted only by an internal function serving the gateway. The
   * envelope is bound to this row's `workspaceId` as AES-GCM additional
   * authenticated data, so moving it to another workspace's row makes it
   * undecryptable rather than portable.
   */
  storageBindings: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.union(
      v.literal("r2"),
      v.literal("s3"),
      v.literal("b2"),
      v.literal("s3-compatible"),
    ),
    endpoint: v.string(),
    region: v.string(),
    bucket: v.string(),
    rootPrefix: v.optional(v.string()),
    accessKeyId: v.string(),
    encryptedSecretAccessKey: v.string(),
    /**
     * How the bucket is addressed in a request URL: as a path segment
     * (`https://endpoint/my-context/note.md`) or as the first host label
     * (`https://my-context.s3.example/note.md`).
     *
     * **Absent means "let the adapter decide", and that is the right default
     * for almost everybody.** R2 and the classic AWS regional endpoints are
     * path-style, which is what `S3Store` assumes when nothing says otherwise,
     * so the overwhelming majority of bindings never carry this field.
     *
     * It exists because there is exactly one case the adapter refuses to guess:
     * an endpoint whose first host label *is* the bucket name. That shape is
     * produced both by a genuine virtual-hosted endpoint
     * (`https://my-context.s3.amazonaws.com`) and by a path-style one that
     * collides by coincidence (`s3.wasabisys.com` with a bucket called `s3`).
     * Guessing wrong means signing requests against a different bucket than the
     * customer named — a silent wrong-bucket write — so `S3Store` throws
     * instead, and `bindStorage` refuses the binding up front with an error
     * that names the two answers. Storing the answer is what makes the refusal
     * fixable rather than a dead end.
     *
     * Emitted to the gateway verbatim (`binding.forcePathStyle` in the
     * control-plane contract) so the adapter that signs the request and the
     * adapter that probed the bucket address it identically.
     */
    forcePathStyle: v.optional(v.boolean()),
    /**
     * Probed at connect time, not assumed. R2 and AWS S3 support conditional
     * writes; B2 and Wasabi do not reliably. We degrade honestly rather than
     * silently dropping conflict detection.
     */
    capabilities: v.object({ conditionalWrite: v.boolean() }),
    status: v.union(
      v.literal("unverified"),
      v.literal("connected"),
      v.literal("error"),
    ),
    lastVerifiedAt: v.optional(v.number()),
    /**
     * Provider-side failure text, truncated and scrubbed on the way in by
     * `recordVerification` — see the redaction there for exactly what is
     * enforced and what is only convention. Any member of the workspace can
     * read this field, so treat it as published.
     */
    lastError: v.optional(v.string()),
    /**
     * The machine-readable half of `lastError`.
     *
     * `lastError` is provider prose: it is written for a human, it is scrubbed
     * and truncated, and it changes whenever a provider rewords a message. A UI
     * that wants to offer "fix the addressing style" for one failure and "paste
     * the key again" for another cannot key off that string without matching on
     * text, so a code is recorded alongside it. The set is enumerated in
     * `functions/provisioning.ts` (`VerificationErrorCode`); anything not in it
     * should be treated by a client as "unknown, show `lastError`".
     *
     * Cleared on success, exactly like `lastError` — a stale code next to a
     * green status misdiagnoses support tickets just as effectively as stale
     * prose.
     */
    errorCode: v.optional(v.string()),
    boundBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * Who may post into a context by email, and where it lands.
   *
   * ## Why this is a security table, not a preferences table
   *
   * A capture address is `<slug>@context.lc` (see `functions/lib/ingestion.ts`
   * and CLAUDE.md, "Ingestion is on the apex"). It is **semi-public**: the
   * console shows it, people paste it into forwarding rules, and it is
   * guessable from a slug that is itself public addressing. Anything that
   * lands there becomes a note, and notes are read back by the owner's AI
   * clients *as trusted context*. So an open inbox is not a spam problem, it
   * is a durable prompt-injection channel into somebody's second brain.
   *
   * Hence the shape: an allowlist that starts closed, and one explicit boolean
   * to open it. There is no "allow" wildcard string, no regex field, and no
   * suffix rule — every one of those is a way to write a policy that admits
   * more than its author meant.
   *
   * ## One row per workspace, seeded at creation
   *
   * `createWorkspace` writes this row with the owner's account email in
   * `allowedSenders`. Seeded rather than inferred on read: "empty list, accepts
   * nothing" and "the owner's address" are different behaviours the moment mail
   * arrives, and which one a workspace has should be a stored fact rather than
   * something a later code path derives. A workspace with **no row** is the
   * fail-closed floor — it accepts nothing — and only workspaces created before
   * this table existed can be in that state.
   *
   * The seeded entry does not follow a later account-email change. That is
   * deliberate: changing the address you log in with must not silently repoint
   * who can write to your context.
   *
   * Note what is absent: no `enabled` flag. `allowedSenders: []` with
   * `allowedDomains: []` and `allowAnySender: false` already means "accept
   * nothing", and a second way to express off is a second thing to check.
   */
  ingestionSettings: defineTable({
    workspaceId: v.id("workspaces"),
    /**
     * Canonical folder form: no leading slash, exactly one trailing slash
     * (`0-inbox/`). Validated syntactically only — see `normalizeTargetFolder`
     * for why existence is not checked here.
     */
    targetFolder: v.string(),
    /** Normalized addr-specs, lowercased. Capped at `MAX_ALLOWED_SENDERS`. */
    allowedSenders: v.array(v.string()),
    /**
     * Whole domains, lowercased, matched by **exact equality**. A subdomain is
     * a different domain and must be listed separately.
     */
    allowedDomains: v.array(v.string()),
    /** Explicit opt-in to accept from anyone. Never a default. */
    allowAnySender: v.boolean(),
    updatedBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * Fixed-window counters for the operations that must not be unbounded.
   *
   * Today that is workspace creation, because a workspace claims a name out of
   * a global namespace that has no release path — see `lib/rateLimit.ts` for
   * what this scheme does and does not protect against.
   *
   * Holds no identity of its own: the key is a caller-built string, and the
   * row carries a count and a timestamp and nothing else.
   */
  rateLimits: defineTable({
    key: v.string(),
    windowStartedAt: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),

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
    applicationType: v.optional(
      v.union(v.literal("native"), v.literal("web")),
    ),
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
    scope: v.string(),
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
  oauthGrants: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    clientId: v.string(),
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

  /**
   * Who did what, in which context.
   *
   * `actorUserId` records the acting identity, not just the scope — once
   * "team" is four people, `actorScope: "team"` tells you nothing. Both actor
   * fields are optional because some events have only one (a system job has no
   * client; a browser session has no client id).
   *
   * `details` is deliberately a flat record of scalars: it structurally cannot
   * carry a nested note body, and callers must never put a secret in it.
   */
  auditEvents: defineTable({
    workspaceId: v.id("workspaces"),
    actorUserId: v.optional(v.id("users")),
    actorClientId: v.optional(v.string()),
    action: v.string(),
    /** Bucket-relative paths the action touched. Paths, never content. */
    paths: v.array(v.string()),
    at: v.number(),
    details: v.optional(
      v.record(
        v.string(),
        v.union(v.string(), v.number(), v.boolean(), v.null()),
      ),
    ),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_at", ["workspaceId", "at"]),
});

export default schema;
