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
   * A personal context is a workspace created `kind: "personal"`, with
   * exactly one `owner` member — the person its slug names. It may gain more
   * members when that person shares it; sharing does not change what it is.
   * A shared context is created `kind: "shared"` and has no single personal
   * owner. There is deliberately no separate "personal context" table — see
   * CLAUDE.md, "The workspace model".
   */
  workspaces: defineTable({
    /** Normalized, globally unique, also present as a row in `names`. */
    slug: v.string(),
    displayName: v.string(),
    createdBy: v.id("users"),
    kind: v.union(v.literal("personal"), v.literal("shared")),
    /**
     * Which starting layout was written into the bucket. Purely a record of
     * what onboarding laid down — the tools operate on paths, not on a fixed
     * taxonomy, a `custom` workspace is not second-class, and the owner is free
     * to rename or delete every one of these folders afterwards.
     *
     * Nothing reads this to decide what to write. `applyStructure` passes the
     * choice to the scaffolder directly and patches this field alongside, so a
     * value here can never cause a bucket write on some later, unrelated
     * verification. What actually happened to the bucket is recorded on the
     * storage binding, as `scaffoldReason`.
     */
    structureTemplate: v.union(v.literal("para"), v.literal("custom")),
    /**
     * The root folders the owner named, when they chose `custom`.
     *
     * Kept so the console can show what was laid down without listing the
     * bucket. Not authoritative: the bucket is. If they rename a folder
     * afterwards — which they may, freely — this goes stale, and that is fine.
     */
    customFolders: v.optional(
      v.array(v.object({ folder: v.string(), description: v.string() })),
    ),
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
   * the invitee, and would cost the in-app delivery channel — the invitee's own
   * `listMyInvitations`, which is how a `@name` invitation is answered and how
   * every invitation is answerable when mail does not arrive.
   *
   * That paragraph used to end "while nothing here sends email", which is no
   * longer true: an `email` invitee is mailed a link by
   * `functions/invitationEmail.ts`. The conclusion is unchanged and the reason
   * is worth stating rather than deleting. **The emailed link is not this
   * token being used as a credential.** The token still only addresses the
   * invitation; what signs a recipient in is a separate, single-use,
   * 24-hour `authVerificationCodes` row, minted through `auth:store` and stored
   * as `sha256(code)` like every other sign-in code. Hashing `token` would
   * therefore still buy nothing, and would still cost the channel that answers
   * an invitation when no mail was sent — while the thing that *is* a bearer
   * credential is hashed, in the table that was already built to hash it.
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
    /**
     * When this offer was mailed, if it was.
     *
     * Claimed in a transaction **before** the send, not recorded after it, and
     * present purely so that one row produces at most one message: a retried
     * job, a duplicated schedule, or an operator running the sender by hand all
     * find it set. There is deliberately no resend path.
     *
     * Absent for every `@name` invitation (we have no address), for a
     * deployment with no Resend key, and for an invitation from an account that
     * has not verified its own address. A re-invitation supersedes the row and
     * clears this along with the token, because a new offer is a new message.
     *
     * Not an oracle: it is never returned by `listInvitations`, and the inviter
     * cannot read it or time it — see `functions/invitationEmail.ts`.
     */
    emailSentAt: v.optional(v.number()),
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
   * A standing, revocable grant to read ONE note, addressed to ONE person.
   *
   * This is not a second visibility tier and it must never become one. A share
   * narrows what a named person can reach; it can never widen it. Two rules
   * carry that, and both are enforced at read time rather than here:
   *
   *  - **A share cannot publish a private note.** The entry note must be
   *    `team`-visible under the owner's own `privacy.md` on every read. A note
   *    that was team when the share was created and is private now is
   *    unavailable, and looks exactly like a note that never existed.
   *  - **A share is not a membership.** The recipient gets no `workspaceMembers`
   *    row, so they cannot connect an AI client to this context, cannot list or
   *    search it, and cannot reach any note but the one addressed and whatever
   *    it explicitly links to. Modelling this as a `viewer` role would have
   *    handed every share recipient an MCP grant over the whole team surface,
   *    which is the opposite of what somebody sharing one document intends.
   *
   * ## Addressed to a string, exactly like an invitation
   *
   * `recipient` holds the normalized `@name` or email as typed, and is resolved
   * to an account only when somebody presents the token — see
   * `lib/identities.ts`. The reasoning is `workspaceInvitations`' in full: an
   * outcome that differed between sharing with `@lk` and sharing with
   * `@does-not-exist` would make the share box a name-enumeration endpoint, and
   * anybody with an account has a share box.
   *
   * ## `token` is returned to its creator, and that is not the invitation rule
   *
   * `inviteMember` returns `null` precisely so that no field exists for a
   * difference to hide in. `createShare` returns the token, because the whole
   * point is a link the owner pastes into a chat — and that is safe for a
   * reason worth stating rather than assuming: the token is 32 random bytes
   * minted before anything is looked up, so it is byte-shaped identically
   * whether the recipient exists, does not exist, or is the owner's own
   * grandmother. What the invitation rule forbids is a return value *derived
   * from the recipient*. This one is derived from `crypto.getRandomValues`.
   *
   * Stored in the clear, for `workspaceInvitations`' reason: possession alone
   * authorizes nothing, because resolving a share additionally requires being
   * the addressed identity. A dump of this table is inert for anybody who is
   * not already the recipient.
   *
   * ## `revoked` is terminal, and revocation must survive the link
   *
   * The row is kept rather than deleted so the owner can see that a share
   * existed and ended. A revoked row's token never resolves again, and
   * re-sharing the same note with the same person after a revocation mints a
   * **new** token — otherwise "revoke" would mean "pause", and a link somebody
   * had already forwarded would come back to life.
   */
  noteShares: defineTable({
    workspaceId: v.id("workspaces"),
    /**
     * The one note this share starts at, normalized and bucket-relative.
     *
     * Validated with `normalizePath` and refused if `isPlumbing` — `privacy.md`
     * is the access map itself and `.history/` holds every revision of every
     * note, so neither is ever a thing to hand somebody.
     */
    entryPath: v.string(),
    /**
     * `name` — a `@handle` out of the shared namespace, stored undecorated.
     * `email` — a lowercased address.
     *
     * Explicit rather than derived from the string's shape, so no two readers
     * can guess differently. Same field pair as `workspaceInvitations`.
     */
    recipientKind: v.union(v.literal("name"), v.literal("email")),
    recipient: v.string(),
    createdBy: v.id("users"),
    /** Unguessable, and useless without the matching identity. */
    token: v.string(),
    status: v.union(v.literal("active"), v.literal("revoked")),
    /**
     * Whether this share's link may unfurl with the note's title.
     *
     * A per-share choice because it is a per-share disclosure: the card is
     * rendered for an unauthenticated crawler, so whoever holds the URL learns
     * the title without signing in. Content is never on the card at any
     * setting. Defaults to `true` — a link that previews as bare product
     * branding does not get clicked, and a share nobody opens is a share that
     * did not happen.
     */
    titleInPreview: v.boolean(),
    /**
     * Absent means no expiry, and that is the default.
     *
     * Deliberately unlike an invitation, which is a one-time offer that should
     * die unanswered. A share is a standing document link somebody may bookmark
     * or come back to in a year; an expiry silently breaks it, and the owner —
     * who can see every share and revoke any of them in one click — is a better
     * control than a clock nobody set.
     */
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    /** The owner's own listing, narrowed in the index for `listInvitations`' reason. */
    .index("by_workspace_status", ["workspaceId", "status"])
    /** "Shared with me": the `(kind, recipient)` prefix finds every share addressed to you. */
    .index("by_recipient", ["recipientKind", "recipient", "status"])
    .index("by_token", ["token"])
    /**
     * The one row a re-share must find. Sharing the same note with the same
     * person twice is one grant, not two — otherwise revoking would be a game
     * of whack-a-mole against rows the owner cannot tell apart.
     */
    .index("by_workspace_entry_recipient", [
      "workspaceId",
      "entryPath",
      "recipientKind",
      "recipient",
    ]),

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
      v.literal("dropbox"),
    ),
    /**
     * ## Two shapes in one table, and why the S3 fields became optional
     *
     * Every field below used to be required, because every binding was a
     * bucket. Dropbox has no endpoint, no region, no bucket and no access key
     * — it has an OAuth grant and a folder — so the S3 five are now optional
     * and **which set is required is a function of `provider`**.
     *
     * That is a real loss: the schema no longer refuses a half-built binding
     * on its own. It is bought back in `bindStorage`, which validates per
     * provider before writing, and in the gateway, which rejects a binding
     * missing what its own provider needs rather than half-building a store.
     * Both have tests. A validator that cannot express "these five together or
     * those two together" is the trade; splitting into two tables would put
     * the workspace→storage relationship in two places, which is worse.
     */
    endpoint: v.optional(v.string()),
    region: v.optional(v.string()),
    bucket: v.optional(v.string()),
    /**
     * The folder inside the customer's storage, applied at the adapter
     * boundary and invisible above it.
     *
     * For S3 this is the optional prefix inside a bucket. For Dropbox it is
     * the folder inside the app folder, and it is how one Dropbox account
     * holds more than one context.
     *
     * **It is the customer's choice, never ours.** `CLAUDE.md` forbids
     * namespacing somebody's storage on their behalf; a prefix we derived and
     * did not show them is exactly that, wearing a different name. Pre-fill it
     * in the console, show it, let them change it — do not compute it silently
     * from a workspace id.
     */
    rootPrefix: v.optional(v.string()),
    accessKeyId: v.optional(v.string()),
    encryptedSecretAccessKey: v.optional(v.string()),
    /**
     * The Dropbox grant. Envelopes from `encryptSecret`, exactly like the S3
     * secret, and subject to the same rule: never returned by a
     * client-callable function, never logged.
     *
     * **The refresh token never leaves the control plane.** The gateway is
     * handed a short-lived access token and nothing else, so a compromised
     * gateway yields minutes of one workspace's storage rather than the
     * standing ability to mint tokens for it. That is the same reasoning as
     * "never cache a decrypted credential across requests", one layer up.
     *
     * `accessTokenExpiresAt` exists so a refresh happens on a schedule rather
     * than on a 401: discovering expiry by failing a customer's read is a
     * worse way to find out, and Dropbox's access tokens are short by design.
     */
    encryptedRefreshToken: v.optional(v.string()),
    encryptedAccessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    /**
     * Whose Dropbox this is. Not a secret and not a credential — it is what
     * lets the console say which account is connected, and lets a reconnect
     * notice that a *different* account just arrived, which is the difference
     * between "you signed in again" and "your context now points somewhere
     * else".
     */
    dropboxAccountId: v.optional(v.string()),
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
    /**
     * WHAT WE FOUND IN THE BUCKET, AND WHAT WE DID ABOUT IT.
     *
     * This pair is the whole reason onboarding can stop asking a question it
     * can answer itself. `verifyStorageBinding` already looks at the bucket in
     * order to decide whether scaffolding is safe; before these fields existed
     * that conclusion was computed, used, and thrown away, so a client had no
     * way to tell "your context is already here" from "this bucket is empty"
     * without a credential of its own.
     *
     * `scaffolded` — did *we* write files. False for a bucket that already had
     * a context, and false for one we have only looked at.
     *
     * `scaffoldReason` — a code from a closed set (`ScaffoldState` in
     * `functions/provisioning.ts`):
     *
     *  - `existing-context` — the bucket already holds somebody's notes.
     *    Nothing was written and nothing will be. **Do not prompt for a
     *    structure; there is one.**
     *  - `empty`           — verified, reachable, writable, and empty. This is
     *    the only state in which asking PARA-or-custom makes sense.
     *  - `created`         — a starting layout was written, in full.
     *  - `partial`         — the essential file landed and something
     *    best-effort did not. **This is a success**: the bucket is a working
     *    context. `scaffoldMissing` says what is absent.
     *  - `failed`          — an essential file did not land. Not a context yet.
     *  - `not-attempted`   — verification did not get far enough to look.
     *
     * Both absent on a binding that has never been verified. Readable by every
     * member, like the rest of this row; neither carries note content, a key
     * name, or anything a client did not already send us.
     */
    scaffolded: v.optional(v.boolean()),
    scaffoldReason: v.optional(v.string()),
    /**
     * WHAT WE STILL OWE THIS BUCKET.
     *
     * Keys of the layout the owner chose that are not in the bucket: written
     * by every scaffold attempt, empty once one completes, absent until one
     * runs. Two jobs, and the second is the load-bearing one:
     *
     *  1. It is the honest half of `partial` — the console can name the two
     *     READMEs that did not land, instead of calling the whole thing failed.
     *  2. **It is how we tell our own half-written scaffold from a vault that
     *     was here before we arrived.** Both look like "the bucket already
     *     holds a context" to anything reading the bucket, and treating them
     *     the same is what made a partly-failed scaffold impossible to finish
     *     through the product (issue #22). This field can only ever be
     *     non-empty because *we* observed this bucket empty and then wrote into
     *     it — so a non-empty value is the licence `applyStructure` needs to
     *     retry, and `bindStorage` clears it, because it describes one bucket.
     *
     * Key names this control plane generated. Never provider text, never note
     * content.
     */
    scaffoldMissing: v.optional(v.array(v.string())),
    /**
     * HOW MANY NOTES WERE IN THE BUCKET WHEN SOMETHING LAST LOOKED.
     *
     * A count, a timestamp, and whether the count is a total or a floor. All
     * three absent until a verification has actually walked the bucket, and
     * that absence is load-bearing: issue #25 was the console printing "1,284
     * objects" over a bucket holding six, from a constant nobody had measured.
     * A missing value must cost a tile rather than produce a plausible one.
     *
     * `noteCountedAt` is separate from `lastVerifiedAt` on purpose. A
     * verification can succeed and still learn nothing about the contents — the
     * listing failed partway, or the walk hit its budget — and a tile that
     * dated its number from the last *verification* would be attributing a
     * stale count to a fresh look.
     *
     * `noteCountTruncated` travels with the number everywhere it goes. The walk
     * is bounded (`lib/noteCount.ts`), so a large enough context yields a floor,
     * and a floor rendered as a total is #25 with extra steps.
     *
     * Metadata, not content: three numbers about somebody's bucket, no key
     * names, no note text. This is the same category as `scaffolded` — a thing
     * we observed at a moment we held a credential, which a query cannot
     * recompute without becoming a public function that opens one.
     */
    noteCount: v.optional(v.number()),
    noteCountedAt: v.optional(v.number()),
    noteCountTruncated: v.optional(v.boolean()),
    boundBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * ONE IN-FLIGHT ATTEMPT TO CREATE A BUCKET IN SOMEBODY ELSE'S CLOUD ACCOUNT.
   *
   * A person who has a Cloudflare account but no bucket hands us one credential
   * powerful enough to act on that account; we create a bucket and mint an S3
   * key scoped to that one bucket, and what persists afterwards is exactly what
   * a manual connect would have left behind — a `storageBindings` row and
   * nothing else. This table exists only for the seconds in between.
   *
   * ## Why the setup credential is here at all, and why it leaves
   *
   * The credential that can create buckets can also mint further credentials,
   * so it is categorically more dangerous than the bucket key it produces. It
   * is written here **encrypted, bound to this workspace** for exactly one
   * reason: the flow is a public entry point that *schedules* an internal
   * action rather than calling one, so the plaintext cannot be handed across
   * that gap in memory (see CLAUDE.md, "Scheduling is not calling"). The
   * envelope is the only channel, and it is closed the moment it has been used:
   *
   *  - **succeeded** — the whole row is deleted in the same transaction that
   *    writes the binding. Success leaves no trace here on purpose; the
   *    binding is the record.
   *  - **failed** — `encryptedSetupCredential` is cleared and the row stays,
   *    carrying only `status`, `errorCode` and `error` so the owner can read
   *    what went wrong. A failed attempt must not keep hold of a credential
   *    that could create more buckets.
   *
   * There is therefore no `succeeded` status: a row here is pending or failed,
   * and a test asserts the table is empty after a successful run.
   *
   * ## Why failures are recorded here rather than on the binding
   *
   * Until the S3 key is minted there is no binding to record anything on — and
   * once there is one, a *new* provisioning attempt that fails must not flip a
   * working binding to `error`. The vocabulary deliberately mirrors
   * `storageBindings` (`status`, `errorCode`, `error`) so a console renders
   * both the same way; see `ProvisionErrorCode` in `functions/lib/cloudflare.ts`
   * for the closed set.
   */
  cloudflareProvisioning: defineTable({
    workspaceId: v.id("workspaces"),
    /** The owner who started it. Re-authorized at write time, never trusted. */
    requestedBy: v.id("users"),
    /**
     * Where the setup credential came from.
     *
     * Downstream they are identical — both are a `Bearer` value — so this is
     * recorded rather than branched on. `oauth` is in the union because
     * Cloudflare's third-party OAuth exists and this is where it lands; the
     * public entry point accepts only `api-token` today, and will keep
     * refusing `oauth` until the open questions in `lib/cloudflare.ts` are
     * closed. A literal in a schema is not a feature.
     */
    credentialSource: v.union(v.literal("api-token"), v.literal("oauth")),
    /**
     * The setup credential, AES-GCM sealed and bound to `workspaceId`.
     *
     * **Present only while `status` is `pending`.** Absent on every failed row
     * and on no successful one, because a successful row does not exist.
     */
    encryptedSetupCredential: v.optional(v.string()),
    /** The customer's Cloudflare account id. Configuration, not a secret. */
    accountId: v.string(),
    bucket: v.string(),
    jurisdiction: v.union(
      v.literal("default"),
      v.literal("eu"),
      v.literal("fedramp"),
    ),
    locationHint: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("failed")),
    /** A `ProvisionErrorCode`. Ours, from a closed set — never provider text. */
    errorCode: v.optional(v.string()),
    /**
     * Human-readable failure text: our sentence, plus Cloudflare's own detail
     * redacted of the setup credential and truncated. Readable by every member
     * of the workspace, so treat it as published.
     */
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    /**
     * When this row's *present* state stops being current.
     *
     * Two meanings, one field, because a row only ever has one deadline:
     * while `pending` it is the moment the attempt is abandoned — the sweep
     * marks it failed and destroys the sealed credential — and once `failed`
     * it is the moment the record itself is deleted.
     *
     * **The pending half is a credential control, not housekeeping.** Without
     * it, an attempt whose action never ran leaves an account-level Cloudflare
     * credential sealed on this row forever, which contradicts the invariant
     * this table exists to keep (CLAUDE.md, "The setup credential is not a
     * stored credential") and blocks the owner from starting another attempt.
     *
     * Optional because rows written before the sweep existed have no deadline,
     * and the honest reading of a missing one is "already expired": a pending
     * row from before this field is exactly the stuck row it was added for.
     */
    expiresAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    /** For the sweep, and for nothing else — same reasoning as `oauthAuthorizations`. */
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * Who may post into a **personal** context by email, and where it lands.
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
   * ## Only a personal context has one of these
   *
   * A shared context has no capture address, so it has no row here — not a row
   * with an empty list, no row. Mail lands in a personal context and nowhere
   * else, and a shared context receives a note only when a person moves one
   * there. `functions/lib/ingestionStore.ts` carries the reasoning and
   * `resolvePersonalContextForIngestion` is the single place that decides it.
   *
   * The row is still keyed by `workspaceId` rather than `userId`, because the
   * bucket the capture is written to is keyed that way (`storageBindings`) and
   * a second key would be a second thing to keep in step. The constraint lives
   * on the writers: `seedIngestionSettings` throws for a shared context, and
   * `createWorkspace` only calls it for a personal one.
   *
   * ## One row per personal context, seeded at creation
   *
   * `createWorkspace` writes this row with the owner's account email in
   * `allowedSenders`. Seeded rather than inferred on read: "empty list, accepts
   * nothing" and "the owner's address" are different behaviours the moment mail
   * arrives, and which one a context has should be a stored fact rather than
   * something a later code path derives. A personal context with **no row** is
   * the fail-closed floor — it accepts nothing — and only contexts created
   * before this table existed can be in that state.
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
   * A short-lived capability the email worker presents to fetch a credential.
   *
   * ## What it is for
   *
   * `/gateway/binding` — the MCP gateway's credential route — requires two
   * proofs: the gateway secret, *and* an end user's OAuth access token, with the
   * workspace derived from the grant that token resolves to. That is what makes
   * a leaked gateway secret worth nothing on its own.
   *
   * **An inbound email has no user token.** Nobody is present and nothing was
   * authorized just now, so the two-proof shape cannot be reproduced. This table
   * is the narrowest replacement found for the second proof: instead of the
   * caller proving *who* it is acting for, the control plane hands it something
   * it minted, bound to one context, and refuses to be told which context to
   * open.
   *
   * The property that survives, and it is the important half: **nothing the
   * caller sends can select a row.** `/gateway/ingest/resolve` takes a name and
   * mints a ticket for whatever that name resolved to; `/gateway/ingest/binding`
   * takes only the ticket. There is no request field anywhere in the ingest
   * contract that names a context.
   *
   * The property that does not survive is stated plainly in
   * `infra/email-worker/src/controlPlane.ts`: a leaked `EMAIL_WORKER_SECRET`
   * yields one person's personal-context credential with no human in the loop.
   * It is bounded by personal contexts only, ingestion-enabled owners only, a
   * rate limit on resolve, and this table's TTL and single use.
   *
   * ## Why the ticket is stored hashed
   *
   * Same rule as `oauthGrants`: the plaintext exists in the worker's memory for
   * the seconds it takes to spend it, and nowhere else. A dump of this table is
   * inert — it names workspaces that were sent mail, which is already visible in
   * the audit trail, and cannot be replayed.
   *
   * ## Single use, twice over
   *
   * `bindingIssuedAt` and `recordedAt` are stamped on first use of their
   * respective routes and checked before the second. A ticket therefore buys at
   * most one credential and at most one accounting write. Rows past `expiresAt`
   * are refused on read whether or not anything has swept them.
   */
  ingestionTickets: defineTable({
    /** SHA-256 of the opaque ticket, lowercase hex. Never the plaintext. */
    hashedTicket: v.string(),
    /**
     * The personal context this ticket opens, fixed at mint time.
     *
     * The only way a row gets here is `resolvePersonalContextForIngestion`
     * answering a name lookup, so this is never a shared context and never
     * something a caller chose.
     */
    workspaceId: v.id("workspaces"),
    /** The SMTP-reported size resolve was told about. Accounting only. */
    sizeBytes: v.number(),
    createdAt: v.number(),
    expiresAt: v.number(),
    /** Set the first time this ticket is exchanged for a credential. */
    bindingIssuedAt: v.optional(v.number()),
    /** Set the first time this ticket is used for accounting. */
    recordedAt: v.optional(v.number()),
  })
    .index("by_hashed_ticket", ["hashedTicket"])
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * Fixed-window counters for the operations that must not be unbounded.
   *
   * Today that is workspace creation, because a workspace claims a name out of
   * a global namespace that has no release path, and email ingestion resolve,
   * because it is the one route a total stranger can drive by sending mail —
   * see `lib/rateLimit.ts` for what this scheme does and does not protect
   * against.
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
