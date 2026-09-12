import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { supaAuthTables } from "@supa-media/convex/schema";

/**
 * Control-plane schema for Context.
 *
 * METADATA ONLY. Note content lives exclusively in the customer's own bucket
 * (see CLAUDE.md, "The customer owns the content, and can always leave with it"). Nothing in this file may
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
    kind: v.union(v.literal("user"), v.literal("workspace"), v.literal("group")),
    /** Set when `kind === "user"`. */
    userId: v.optional(v.id("users")),
    /** Set when `kind === "workspace"`. */
    workspaceId: v.optional(v.id("workspaces")),
    /**
     * Set when `kind === "group"`.
     *
     * A group claims a row here for the same reason a workspace does: a privacy
     * rule names a person and a group with the same `@name` token, so the two
     * cannot be allowed to collide. Keeping the third kind in this table makes
     * that one lookup rather than three that could race past each other.
     */
    groupId: v.optional(v.id("workspaceGroups")),
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
   * A named set of people inside one workspace, for a folder rule to point at.
   *
   * `name` is the FULL, slug-prefixed name (`supa-leads`) exactly as
   * `privacy.md` carries it after the `@` — assembled by `buildGroupName` from
   * the workspace's own slug, never accepted from a caller. That is what stops
   * one workspace minting a name inside another's space in a namespace they
   * share with every username.
   *
   * The group is the control plane's object and the manifest holds only the
   * reference, which is the whole split: a name in a file is not a fact, and
   * removing somebody from the workspace closes every folder at once without
   * the bucket being touched.
   */
  workspaceGroups: defineTable({
    workspaceId: v.id("workspaces"),
    /** Normalized, slug-prefixed, and unique across the `names` table. */
    name: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_name", ["name"]),

  /**
   * One person named in one group.
   *
   * **A row here grants nothing on its own.** Resolution intersects it with
   * `workspaceMembers`, so a name left behind after somebody leaves the
   * workspace is inert rather than a hole — see `resolveGroupMembers`. That is
   * what lets the manifest keep a reference it cannot check.
   *
   * `workspaceId` is denormalized off the group so a workspace's rows can be
   * swept without walking its groups first, and so every row carries the tenant
   * it belongs to rather than inheriting it through a join.
   */
  workspaceGroupMembers: defineTable({
    groupId: v.id("workspaceGroups"),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    addedBy: v.id("users"),
    addedAt: v.number(),
  })
    .index("by_group", ["groupId"])
    .index("by_group_user", ["groupId", "userId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"]),

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
    /**
     * `name` — a `@handle` out of the shared namespace, stored undecorated.
     * `email` — a lowercased address.
     * `members` — **not a person at all**: anyone whose membership of this
     *   context already lets them read the note. `recipient` is `""`, because
     *   there is nobody to name.
     * `anyone` — **an unlisted link**: nobody is addressed and nobody signs in.
     *   `recipient` is `""` for the same reason. This is the one kind where
     *   possession of the token IS the authorization, and it is deliberate —
     *   see "An unlisted share is the third audience" in `CLAUDE.md`. What
     *   keeps it from being the public tier non-negotiable #5 refuses is that
     *   it is still one row, over one note, that the owner revokes, and the
     *   read still runs at `team` scope through the live `privacy.md`: a note
     *   made private is absent through an unlisted link exactly as it is
     *   through a personal one. What it genuinely costs is that revocation
     *   stops future reads and cannot retrieve a copy already taken.
     *
     * One field, not an `audience` beside a recipient. A share's audience
     * stored twice is a share whose two halves can disagree, and the direction
     * that disagreement fails is "more people can read this than the owner
     * chose" — the same reasoning `visibilityTierForGrant` gives for keeping
     * the privacy tier in exactly one place.
     *
     * A `members` share grants **nothing**. It is a locator whose reader is
     * authorised by membership, so removing somebody from the context takes the
     * link with them. What the token buys is that the URL is unguessable, which
     * is what makes it safe for the link's card to carry the note's title —
     * `/console/@slug?note=…` addresses the same note and must not, because
     * anyone who knows the handle can type it.
     */
    recipientKind: v.union(
      v.literal("name"),
      v.literal("email"),
      v.literal("members"),
      v.literal("anyone"),
    ),
    recipient: v.string(),
    createdBy: v.id("users"),
    /**
     * When the current holder took the recipient handle, as of the moment this
     * share was written — or absent, meaning nobody held it.
     *
     * This is what separates the two ways a `@name` can resolve to somebody the
     * sharer was not addressing, which a bare "the claim must predate the
     * share" comparison cannot tell apart:
     *
     *  - **Nobody held it** (absent). Sharing with a colleague who is not on
     *    Context yet is a supported flow — `createShare` accepts an unclaimed
     *    handle on purpose, so that sharing with `@nobody` is indistinguishable
     *    from sharing with a real person. Whoever claims it first is the person
     *    the sharer meant, and the share must survive them signing up.
     *  - **Somebody held it** (a timestamp). Then the share was addressed to
     *    *that* claim, and a later one — the name freed by a deletion and
     *    re-claimed by a stranger — is a different person wearing the handle.
     *
     * A timestamp rather than a `userId`, deliberately: resolving the recipient
     * at creation time is exactly what `inviteMember` refuses to do, because it
     * would make the share box a name-enumeration endpoint. This records *when
     * the handle was taken*, never by whom.
     *
     * There is no equivalent for an email recipient. `emailVerificationTime` is
     * re-stamped by `@convex-dev/auth` on every verifying sign-in, so it pins
     * nothing; the teardown sweep is the whole control there.
     *
     * Absent on rows written before this field existed, which reads as "nobody
     * held it" and so does not pin them. That is the safe direction only
     * because the sweep, not this, is the primary control for a freed handle —
     * see `voidCapabilitiesAddressedTo`.
     */
    recipientHeldSince: v.optional(v.number()),
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
     * The title the link unfurls with, or absent for none.
     *
     * Owner-chosen, defaulted from the note's filename, and **never read from
     * the note's contents** — see `lib/shareTitle.ts`. A title taken from the
     * body would mean an anonymous crawler triggering a GET against the
     * customer's own bucket on every unfurl, and would put note content in the
     * control plane, which non-negotiable #1 forbids. A path is metadata; this
     * is derived from one.
     *
     * Bounded at `MAX_PREVIEW_TITLE` on the way in, so the size of a response
     * served to unauthenticated readers cannot vary with something typed.
     */
    previewTitle: v.optional(v.string()),
    /**
     * Two or three things inside a team-linked **folder**, for its card.
     *
     * Absent for every note share and for every folder with nothing a `team`
     * reader may see. Present only on a `members` row, because a personal share
     * is note-only and its card is never reached by the guessable address this
     * list is published to.
     *
     * ## Where these come from, and where they do not
     *
     * A **listing** of the folder, taken once when the owner made or refreshed
     * the link, at `team` scope, through the same privacy engine the console
     * and the gateway read through. So a private note and a private subfolder
     * are gone before this array exists, and nothing here counts what was
     * dropped — a total over the folder rather than over the visible set is an
     * existence oracle by subtraction.
     *
     * Never note *content*. A listing is metadata about keys, the way
     * `previewTitle` is metadata about a path; a body would be the thing
     * non-negotiable #1 keeps out of the control plane.
     *
     * ## Frozen at link time, exactly as the title is
     *
     * Nothing re-reads the bucket on an unfurl — a crawler is unauthenticated,
     * uncontrolled and endlessly retrying, and making one trigger a LIST
     * against the customer's own bucket on their quota is what
     * `lib/shareTitle.ts` refuses for the title on the same grounds. The cost
     * is the same too and is stated rather than discovered: a child that was
     * `team` when the owner pressed Copy link stays on the card after they make
     * it private. Re-linking the folder re-takes the snapshot; revoking is what
     * takes the card back. And a card already unfurled cannot be taken back at
     * all.
     *
     * Bounded by `MAX_PREVIEW_CHILDREN` and `MAX_PREVIEW_CHILD_NAME` on the way
     * in and again on the way out, so a row written by an older deployment
     * cannot widen a response served to an anonymous reader.
     */
    previewChildren: v.optional(v.array(v.string())),
    /**
     * The leaf of the card image in the owner's own bucket, under `.images/`.
     *
     * **Their bytes, in their storage.** A card is derived from a note they
     * wrote and lives where that note lives, so revoking our storage credential
     * takes the previews with it — which is the product's whole promise, not a
     * cost of it.
     *
     * Absent until the card has been rendered, and absent forever for a share
     * whose title has a glyph the bundled font cannot draw. Both mean the same
     * thing to every reader: serve the static product card.
     *
     * The leaf carries a hash of the title, so retitling a share writes a new
     * object rather than mutating one — the Workers cache is per-datacenter and
     * has no global purge, so a changed URL is the only invalidation available.
     * The old object is deliberately left behind: these are the customer's
     * bytes in the customer's bucket, and the images feature's rule is that
     * nothing here ever collects.
     */
    cardImageLeaf: v.optional(v.string()),
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
   * A paid copy from customer-owned storage into a managed bucket.
   *
   * The source binding remains live until copy and verification finish. Its
   * id is pinned so a reconnect during the copy makes cutover fail closed.
   * The destination credential is workspace-bound encrypted metadata and is
   * never returned by a public function.
   */
  managedStorageMigrations: defineTable({
    workspaceId: v.id("workspaces"),
    sourceBindingId: v.id("storageBindings"),
    targetEndpoint: v.string(),
    targetBucket: v.string(),
    targetAccessKeyId: v.string(),
    encryptedTargetSecretAccessKey: v.string(),
    status: v.union(v.literal("copying"), v.literal("failed")),
    phase: v.union(
      v.literal("count"),
      v.literal("copy"),
      v.literal("verify_source"),
      v.literal("verify_target"),
    ),
    cursor: v.optional(v.string()),
    objectsCopied: v.number(),
    /** Stable denominator measured before the first copy pass. */
    objectsTotal: v.optional(v.number()),
    /** Cursor-independent progress within the current phase. */
    objectsProcessedInPhase: v.optional(v.number()),
    changesInPass: v.number(),
    readyToCutover: v.optional(v.boolean()),
    errorCode: v.optional(v.string()),
    startedBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * THE KEY(S) THAT OPEN ONE CONTEXT'S ENCRYPTED NOTES.
   *
   * See `docs/decisions/encryption.md`. **One *live* row per workspace, plus
   * zero or more retired ones** — this used to be exactly one row per
   * workspace, and grew a second shape when workspace-key rotation shipped:
   * `retiredAt` is `undefined` on the single current row and a timestamp on
   * every generation a rotation has moved past. Each row holds the workspace
   * data key as a `v2:` envelope from `functions/lib/crypto.ts` — the same
   * scheme, the same keyset, the same AAD binding and the same rotation pass
   * (`STORAGE_SECRET_ENCRYPTION_KEY`'s, not this table's own) as the bucket
   * credential beside it. Never in the clear here, never in Markdown, never in
   * the customer's bucket, never in a log — except the owner's own deliberate
   * export.
   *
   * **Its own table rather than a column on `storageBindings`, and that is not
   * tidiness.** A customer who rebinds storage — a new bucket, a new provider,
   * a reconnected Dropbox — replaces their binding row. A key living on it
   * would take every note they had already encrypted with it, silently, in the
   * one flow whose entire purpose is that the notes come with them. The key
   * that opens a context outlives the storage those notes happen to sit in.
   *
   * `generation` is the label a note's own frontmatter carries
   * (`context_encryption_key: ws:k1`) and each envelope recipient's `id`. It
   * is what makes a key rotation a resumable re-wrap — a listing finds what is
   * still on the old generation — rather than a re-encrypt of every note in
   * somebody's bucket.
   *
   * **A retired row is never deleted by this codebase.** A note this
   * deployment has not yet re-wrapped — including one restored from bucket
   * versioning, or written by a client syncing the bucket directly while a
   * rotation was mid-walk — still names an old generation, and purging that
   * generation's row would make such a note permanently unreadable. See
   * "Rotation" in `docs/decisions/encryption.md` for the grace-period policy
   * this leaves as a deliberate, manual, future operator action rather than an
   * automatic sweep.
   *
   * **Nothing may write different key material into an existing row.** A
   * second key over the first makes every note already encrypted under it
   * unreadable, and it would look exactly like a fix for "the key was
   * missing". The two writers that exist are `applyDataKeyRekey`, which
   * re-seals the *same* material under a new envelope key, conditional on the
   * exact bytes it read — the `STORAGE_SECRET_ENCRYPTION_KEY` rotation pass,
   * which must reach this column, because an envelope left behind on a
   * retired envelope key is that same unrecoverable loss arriving from the
   * other side — and `startWorkspaceKeyRotation`, which only ever *inserts* a
   * new row with fresh, random material and *patches* `retiredAt` on the row
   * it supersedes; it never rewrites `encryptedDataKey` on an existing row.
   */
  workspaceDataKeys: defineTable({
    workspaceId: v.id("workspaces"),
    generation: v.string(),
    encryptedDataKey: v.string(),
    /**
     * Set the moment a rotation supersedes this generation with a new one.
     * `undefined` on the workspace's current generation — the one `encryptNote`
     * writes with — and on every workspace that has never rotated, which is
     * every workspace before this field existed.
     */
    retiredAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * ONE WORKSPACE-KEY ROTATION, IN PROGRESS OR DONE.
   *
   * See "Rotation" in `docs/decisions/encryption.md`. This table's only job is
   * the guard a rotation needs and a single `workspaceDataKeys` row cannot
   * give it: **at most one rotation may be in progress for a workspace at a
   * time.** `startWorkspaceKeyRotation` re-reads under its own mutation before
   * inserting a second one, exactly the same race-safety
   * `insertDataKeyIfAbsent` already relies on for a workspace's very first key.
   *
   * The actual re-wrap walk — which notes are done, which are left — is
   * **not** tracked here, and is not tracked anywhere else either: there is no
   * cursor, in this table, in the bucket, or in a file. Each note carries its
   * own generation in its own frontmatter, so "already done" is read off the
   * note rather than off a second piece of state that could go stale, and a
   * walk that is idempotent by construction (`rewrapWorkspaceRecipient` is
   * safe to call twice) needs no cursor to be resumable — only a boolean
   * saying whether one may be *started*. This table is that boolean, shared
   * across every Worker isolate and every client, which the bucket alone
   * cannot be: two racing gateways would both find no rotation under way and
   * both try to mint a new generation.
   *
   * What that costs is in `docs/decisions/encryption.md` under "Rotation" and
   * is real: every call re-lists the bucket, and reads every note it examines.
   */
  workspaceKeyRotations: defineTable({
    workspaceId: v.id("workspaces"),
    fromGeneration: v.string(),
    toGeneration: v.string(),
    status: v.union(v.literal("in_progress"), v.literal("done")),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * ONE CONNECTED GOOGLE ACCOUNT. See `docs/decisions/communications.md`.
   *
   * **Generalized from a Gmail-only `mailConnections` row (2026-09-07) to one
   * Google account carrying one OAuth grant and any number of enabled
   * `products`** — Gmail, and (built by sibling work on this same shape)
   * Calendar and Chat. One consent, one refresh token, one place the account
   * identity lives; each product gets its own nested settings-and-cursor
   * object rather than its own table, because they share the grant, the
   * owner, and the disconnect/revoke story, and only differ in what they sync
   * and where their cursor lives.
   *
   * KEYED BY `workspaceId`, NEVER `userId` — same rule as `storageBindings`,
   * for the same reason: the connection belongs to the context, not to
   * whoever happened to click Connect. **Only a `kind: "personal"` workspace
   * may hold one** (`identity-and-access.md`, "Mail lands in a personal
   * context and nowhere else", which this generalizes to every product here)
   * — enforced in `functions/googleConnect.ts`, not here, because a schema
   * cannot see a sibling table's field.
   *
   * This is metadata about the connection, never product content. Gmail
   * messages are rendered by `packages/communications` straight into the
   * customer's own bucket at `0-inbox/email/<gmail.mailboxSlug>/`; nothing
   * here ever holds a subject, a body, a sender, or a calendar event's text.
   *
   * `encryptedRefreshToken` is a `v2:` envelope from `functions/lib/crypto.ts`,
   * bound to this row's `workspaceId` as AAD — identical scheme to
   * `storageBindings.encryptedRefreshToken`, and it rides the same rotation
   * pass (`listGoogleConnectionRekeyCandidates` / `applyGoogleConnectionRekey`
   * in `functions/storage.ts`). **The token stays at the top level, never
   * nested under a product**, because it is one grant covering every enabled
   * product — nesting it would either duplicate one token three ways or make
   * the rotation walk hunt through per-product objects for a column that is
   * the same secret in each. The gateway is handed a short-lived access token
   * to talk to Google and the refresh token never leaves the control plane —
   * same reasoning as the Dropbox grant one table over.
   */
  googleConnections: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.literal("google"),
    /** The address as the person knows it. Never a path segment; see `gmail.mailboxSlug`. */
    address: v.string(),
    encryptedRefreshToken: v.string(),
    encryptedAccessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    /**
     * Every scope Google actually granted for this account, verbatim from the
     * token response — never assumed from what was requested. A downgraded
     * consent (the person unchecked something) is visible here rather than
     * discovered as a 403 three months later. Per-product scope slices live
     * on each product's own object below (`gmail.scopes`), computed from this
     * same verbatim list — two views of one fact, never two facts.
     */
    scopes: v.array(v.string()),
    /**
     * Whose Google account this is. Not a secret — it is what lets the console
     * show which account is connected and notice a reconnect landing on a
     * *different* account, the same role `dropboxAccountId` plays.
     */
    googleAccountId: v.string(),
    /**
     * Which products this connection actually syncs. A product appearing here
     * with no matching nested object below is a connection mid-setup, never a
     * steady state a reader should trust — `functions/googleConnect.ts` writes
     * both in the same mutation.
     */
    products: v.array(
      v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat")),
    ),
    /**
     * Gmail's own settings and cursor. Present iff `"gmail"` is in `products`.
     * See `docs/decisions/communications.md` for what each field argues.
     */
    gmail: v.optional(
      v.object({
        /**
         * The scopes relevant to Gmail specifically, sliced from the
         * account's own `scopes` at connect time — recorded per product,
         * verbatim, per the same rule the top-level field states.
         */
        scopes: v.array(v.string()),
        /**
         * `chooseMailboxSlug(address, taken)` from `packages/communications`,
         * decided once at connect time and never recomputed — recomputing it
         * against a different `taken` set would rename the folder a person's
         * mail is already in.
         */
        mailboxSlug: v.string(),
        /**
         * How far back the first backfill reaches, in days. Per-connection and
         * fixed at connect time: changing it later is a second backfill, not a
         * setting flip, so this is what a reconnect or "sync more" reads to
         * decide how far to widen.
         */
        backfillDays: v.number(),
        /**
         * Which Gmail system labels are synced. `spam` and `trash` are
         * deliberately never valid values here — v1 excludes both
         * unconditionally, argued in `docs/decisions/communications.md` — so
         * the type itself is the enforcement, not a runtime check elsewhere.
         */
        folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
        /** Off by default. See "Retention: raw MIME is off by default". */
        storeRawMime: v.boolean(),
        /**
         * `"store"` is the working default per the owner's 2026-09-07
         * decision — an attachment a message references should land
         * somewhere referenceable in the bucket. `"metadata-only"` stays
         * available as the quota-conscious opt-out. See
         * `docs/decisions/communications.md`, "Attachments are fetched into
         * the bucket, retained on a timer".
         */
        attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
        /**
         * Days an attachment's bytes stay in the bucket after being written,
         * or `"forever"` to never expire it. Per-connection, because the
         * right answer for a receipts inbox and a newsletter inbox differ.
         * Absent only for a row written before this field existed, and
         * `sweepExpiredAttachments` treats absent the same as the documented
         * 90-day default.
         */
        attachmentRetentionDays: v.optional(
          v.union(v.number(), v.literal("forever")),
        ),
        /**
         * Customer-visible folder where this mailbox's day notes and
         * attachments land. Absent on rows written before integration settings
         * existed, in which case the old canonical folder is used.
         */
        destinationFolder: v.optional(v.string()),
        /**
         * A hard ceiling on bytes this connection may write into the bucket
         * — note text and stored attachment bytes both — independent of the
         * customer's overall storage. Backfill and sync both refuse to write
         * past it rather than silently exceeding what the estimator showed
         * before the first fetch.
         */
        quotaBytes: v.number(),
        /**
         * Gmail's sync cursor (`historyId`), advanced after every page this
         * connection has fully processed. Absent until the first backfill
         * completes. A `404` from `history.list` means Gmail expired it —
         * sync treats that as `gapDetected` and falls back to a full
         * reconcile over `backfillDays`, per `docs/decisions/communications.md`.
         */
        historyId: v.optional(v.string()),
        lastSyncedAt: v.optional(v.number()),
      }),
    ),
    /**
     * Calendar's settings and incremental-sync cursor. Event content and the
     * per-account materialized cache stay in customer storage; this row keeps
     * only the `events.list` token and the owner-local date of the last full
     * rolling-horizon refresh.
     */
    calendar: v.optional(
      v.object({
        scopes: v.array(v.string()),
        destinationFolder: v.optional(v.string()),
        syncToken: v.optional(v.string()),
        /** Owner-local date of the last full horizon refresh. */
        lastFullSyncDate: v.optional(v.string()),
        lastSyncedAt: v.optional(v.number()),
      }),
    ),
    /**
     * Chat's own settings and cursor. Both `chat.messages.readonly` and
     * `chat.spaces.readonly` are restricted and sensitive scopes respectively
     * (`docs/decisions/communications.md`), so the CASA assessment gating
     * Gmail gates this too.
     *
     * Shaped differently from the `historyToken` placeholder this field
     * started as, because Chat's own sync module
     * (`apps/mcp/src/communications/googleChat/sync.js`) predates this table
     * and already settled the real shape: Chat pages `spaces.messages.list`
     * by `create_time` **per space**, so one account-wide cursor cannot
     * represent it — `cursors` is a map, keyed by the space's resource name,
     * and one space's failure never stalls another's. `spaceSettings` is a
     * console-facing per-space include/exclude/pause choice, absent for a
     * space that has never been touched (which reads as `"included"` —
     * `docs/decisions/communications.md`, "Default private", the same
     * "absent means the default" rule). `nonceSeed` is not a credential —
     * leaking it only weakens this connection's fence nonce
     * (`packages/communications/src/note.js`, "the nonce is why the fence is
     * worth anything"), never Google account access — so it is generated once
     * at connect time and stored in the clear rather than sealed, and
     * survives a reconnect for the same reason `gmail.mailboxSlug` does.
     */
    chat: v.optional(
      v.object({
        scopes: v.array(v.string()),
        spaceSettings: v.optional(
          v.record(
            v.string(),
            v.union(v.literal("excluded"), v.literal("paused")),
          ),
        ),
        cursors: v.optional(v.record(v.string(), v.string())),
        destinationFolder: v.optional(v.string()),
        nonceSeed: v.string(),
        lastSyncedAt: v.optional(v.number()),
      }),
    ),
    health: v.union(
      v.literal("connecting"),
      v.literal("backfilling"),
      v.literal("active"),
      v.literal("error"),
      v.literal("reconnect_required"),
    ),
    lastError: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    /**
     * HOW OFTEN THIS ACCOUNT IS POLLED, AND WHEN IT IS NEXT DUE.
     *
     * The fields below are the whole scheduling state of the forward sync
     * loop (`functions/googleSync.ts`), and they are **per account, not per
     * product**: one Google account is one grant, so one pass mints one
     * access token and walks whichever products the row enables. A per-product
     * schedule would mint the same credential three times an hour to ask three
     * questions of the same account.
     *
     * They sit at the top level rather than inside `gmail` for that reason and
     * for one more: `nextSyncAt` is indexed, and an index over a field nested
     * inside an optional object is a shape this schema does not otherwise use.
     *
     *  - `syncIntervalMinutes` — the owner's choice, floored at
     *    `MIN_SYNC_INTERVAL_MINUTES` server-side. Absent means the default
     *    (`DEFAULT_SYNC_INTERVAL_MINUTES`), so a row written before this
     *    existed is scheduled rather than stalled.
     *  - `lastSyncAt` — when a pass last **finished**, successfully or not.
     *    Absent means this connection has never synced, which the console
     *    must be able to say out loud: "connected" and "syncing" looking
     *    identical is the defect this loop exists to close.
     *  - `nextSyncAt` — `lastSyncAt + interval`, materialized so the sweep can
     *    ask the index for due rows instead of reading every connection.
     *    Absent means due now, which is what a never-synced row is.
     *  - `syncStartedAt` — set when a pass is claimed, cleared when it
     *    reports. It is the not-overtaking guard: a pass still running is
     *    never started a second time until it has been silent long enough to
     *    be considered lost.
     *  - `lastSyncFailure*` — the last failure this connection had, kept
     *    **after** a later pass succeeds. `lastError` / `errorCode` describe
     *    the connection's health right now and are cleared by a good pass;
     *    somebody asking "did this break overnight?" is asking a different
     *    question, and clearing the answer is how it stopped being askable.
     */
    syncIntervalMinutes: v.optional(v.number()),
    lastSyncAt: v.optional(v.number()),
    nextSyncAt: v.optional(v.number()),
    syncStartedAt: v.optional(v.number()),
    lastSyncFailureAt: v.optional(v.number()),
    lastSyncFailureCode: v.optional(v.string()),
    lastSyncFailure: v.optional(v.string()),
    /**
     * The last pass ran out of history pages before it ran out of history.
     *
     * Gmail's `history.list` is paged and the walk is bounded, so a connection
     * whose cursor is weeks old cannot be caught up in one pass. The cursor
     * still moves — to the last record actually walked, never to the mailbox
     * head — and this says the interval must not be waited out, because the
     * pass already knows there is more. `isDue` reads it; a pass that finishes
     * clears it, which is what stops a connection being due forever.
     */
    syncCatchUp: v.optional(v.boolean()),
    /**
     * Consecutive failed passes, cleared by the first good one.
     *
     * The backoff ladder's input. A flat retry means a mailbox Google is
     * rate-limiting is asked again ~96 times a day, which is the request
     * pattern most likely to keep it rate-limited.
     */
    syncFailures: v.optional(v.number()),
    /**
     * Bytes the forward loop has written into the bucket for this connection.
     *
     * `gmail.quotaBytes` is a lifetime ceiling on what one connection may
     * write, and a ceiling with nothing counting against it is decoration. The
     * historical backfill counted on its run row; a forward loop has no run,
     * so the total lives here and every pass is handed it as
     * `bytesAlreadyUsed`.
     */
    syncBytesWritten: v.optional(v.number()),
    /**
     * Set by disconnect. The row is kept — never deleted outright — so a
     * disconnected connection's sync job can be told apart from one that
     * simply has not synced yet, and so the notes it already wrote are
     * traceable to a connection the console can still show as "disconnected"
     * rather than an account that quietly stopped and left no explanation.
     * The notes themselves are never touched by a disconnect.
     */
    disconnectedAt: v.optional(v.number()),
    boundBy: v.id("users"),
    /**
     * Where provisioning the managed bucket has got to, for the one context
     * this plan is for.
     *
     * On the plan rather than on the binding, because until it succeeds there
     * *is* no binding — and the screen that has to say "creating your storage"
     * is looking at somebody who has paid and has nothing yet. Absent is the
     * ordinary state: a context that never bought managed storage has no
     * answer here and needs none.
     *
     * `failed` is the state that has to exist. Without it the console can only
     * wait, and a person who paid two minutes ago cannot tell a slow webhook
     * from a bucket that will never appear.
     */
    managedProvisioning: v.optional(
      v.union(v.literal("running"), v.literal("ready"), v.literal("failed")),
    ),
    /**
     * Why it failed, from **our** closed set — never Cloudflare's text, which
     * can name an account. The console maps it to a sentence and a next step.
     */
    managedProvisioningError: v.optional(v.string()),
    /** When the last attempt ended, so a retry can be rate-limited by a human. */
    managedProvisioningAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    /** One shared-note writer per workspace at a time. */
    .index("by_workspace_sync_started", ["workspaceId", "syncStartedAt"])
    /** One connection per address per context — the uniqueness `chooseMailboxSlug` assumes for Gmail. */
    .index("by_workspace_address", ["workspaceId", "address"])
    /**
     * The sweep's index: connections that are still connected, oldest due
     * first.
     *
     * `disconnectedAt` leads so a disconnected row is outside the range
     * entirely rather than filtered out after being read — a disconnected
     * connection with an old `nextSyncAt` would otherwise sit at the head of
     * every bounded batch forever and starve the live ones behind it.
     *
     * A row with no `nextSyncAt` sorts before every number, so a never-synced
     * connection is at the front of the queue rather than invisible to it.
     */
    .index("by_sync_due", ["disconnectedAt", "nextSyncAt"]),

  /**
   * User-visible Google sync work.
   *
   * A connection row says which account and products are authorized. It is not
   * a job ledger: calling an account "backfilling" because OAuth completed is
   * the production confusion this table closes. A run row is the thing a person
   * started, the unit a worker advances, and the progress the console renders.
   *
   * Counts are deliberately coarse. The actual message bodies live only in the
   * customer's bucket; Convex records service, days, bytes and safe error
   * codes, never mail subjects, chat text, calendar titles, or object paths.
   */
  googleSyncRuns: defineTable({
    workspaceId: v.id("workspaces"),
    connectionId: v.id("googleConnections"),
    requestedBy: v.id("users"),
    mode: v.literal("backfill"),
    services: v.array(
      v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat")),
    ),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    requestedBackfillDays: v.number(),
    totalUnits: v.number(),
    completedUnits: v.number(),
    itemsFound: v.optional(v.number()),
    daysWithMail: v.optional(v.number()),
    bytesWritten: v.optional(v.number()),
    destinationFolder: v.optional(v.string()),
    currentService: v.optional(
      v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat")),
    ),
    currentUnit: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    transientFailures: v.optional(v.number()),
    /**
     * Where provisioning the managed bucket has got to, for the one context
     * this plan is for.
     *
     * On the plan rather than on the binding, because until it succeeds there
     * *is* no binding — and the screen that has to say "creating your storage"
     * is looking at somebody who has paid and has nothing yet. Absent is the
     * ordinary state: a context that never bought managed storage has no
     * answer here and needs none.
     *
     * `failed` is the state that has to exist. Without it the console can only
     * wait, and a person who paid two minutes ago cannot tell a slow webhook
     * from a bucket that will never appear.
     */
    managedProvisioning: v.optional(
      v.union(v.literal("running"), v.literal("ready"), v.literal("failed")),
    ),
    /**
     * Why it failed, from **our** closed set — never Cloudflare's text, which
     * can name an account. The console maps it to a sentence and a next step.
     */
    managedProvisioningError: v.optional(v.string()),
    /** When the last attempt ended, so a retry can be rate-limited by a human. */
    managedProvisioningAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_connection_created", ["connectionId", "createdAt"])
    .index("by_connection_status", ["connectionId", "status"]),

  /**
   * ONE IN-FLIGHT GOOGLE OAUTH ATTEMPT. Same shape and the same reasoning as
   * `dropboxConnectAttempts` — see that table's comment for the full argument;
   * this restates only what differs.
   *
   * `backfillDays` and `folders` are Gmail's own connect-time choices and
   * travel here rather than being asked for on the callback screen, because
   * the callback may carry no session (see `dropboxConnect.ts`'s
   * `completeDropboxConnect` for why that is a security argument and not a
   * shortcut) — so the choice the person made *before* leaving for Google's
   * consent screen has to survive the round trip somewhere that is not the
   * browser. A future Calendar-or-Chat-only connect attempt carries no Gmail
   * fields at all; they stay optional for exactly that reason.
   */
  googleConnectAttempts: defineTable({
    hashedState: v.string(),
    /**
     * SHA-256 of the value that never travels through Google.
     *
     * `dropboxConnectAttempts.hashedCompletion` carries the argument in full;
     * this flow was written from that one and needs the same binding. Optional
     * only because attempts parked before it existed have none, and those are
     * refused rather than trusted.
     */
    hashedCompletion: v.optional(v.string()),
    encryptedVerifier: v.string(),
    workspaceId: v.id("workspaces"),
    startedBy: v.id("users"),
    redirectUri: v.string(),
    /**
     * Which public callback is allowed to spend this shared-table attempt.
     * Optional only for rows parked before this discriminator existed; those
     * remain product-callback compatible and are refused by the combined Google
     * callback.
     */
    flow: v.optional(
      v.union(
        v.literal("gmail"),
        v.literal("calendar"),
        v.literal("chat"),
        v.literal("google"),
      ),
    ),
    products: v.array(
      v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat")),
    ),
    backfillDays: v.optional(v.number()),
    folders: v.optional(
      v.array(v.union(v.literal("inbox"), v.literal("sent"))),
    ),
    /**
     * The attachment choices made before leaving for Google's consent
     * screen, carried the same way `backfillDays`/`folders` are — see this
     * table's own comment. `attachmentRetentionDays` and
     * `attachmentRetentionForever` split "forever" out of the number rather
     * than union-typing the stored field, because Convex indexes and
     * comparisons on a column are simplest when its type does not vary row
     * to row; `googleConnect.ts` is the only reader and reassembles the
     * `number | "forever"` shape on the way out.
     */
    attachmentMode: v.optional(
      v.union(v.literal("metadata-only"), v.literal("store")),
    ),
    attachmentRetentionDays: v.optional(v.number()),
    attachmentRetentionForever: v.optional(v.boolean()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_hashed_state", ["hashedState"])
    .index("by_expiresAt", ["expiresAt"]),

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
    /**
     * What happens to an attachment: `ignore`, `list`, or `store`. Optional so
     * rows written before this field existed need no backfill; every reader
     * resolves an absent value to `DEFAULT_ATTACHMENT_POLICY`, which is `list`
     * — precisely what the pipeline did while this was a hardcoded constant.
     * An existing context therefore behaves identically on the day this ships.
     */
    attachmentPolicy: v.optional(v.string()),
    /**
     * Per-attachment ceiling in bytes. Absent means
     * `DEFAULT_MAX_ATTACHMENT_BYTES`. Capped on write at
     * `MAX_ATTACHMENT_BYTES_CEILING`, which is bounded by what the gateway will
     * serve back rather than by what a bucket will hold.
     */
    maxAttachmentBytes: v.optional(v.number()),
    updatedBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * Durable gateway work, never note content.
   *
   * A row is minted only while a live user token is present; later Cloudflare
   * Queue attempts present an opaque ticket for that already-authorized row.
   * The ticket is stored hashed, and the payload is deliberately small: which
   * bounded gateway operation to resume, not the files or bytes it will touch.
   */
  gatewayJobs: defineTable({
    hashedTicket: v.string(),
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    actorClientId: v.string(),
    grantId: v.id("oauthGrants"),
    kind: v.union(v.literal("materialize_move")),
    moveId: v.optional(v.string()),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
    leasedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    progressPhase: v.optional(v.union(v.literal("copying"), v.literal("deleting"))),
    progressCompleted: v.optional(v.number()),
    progressTotal: v.optional(v.number()),
  })
    .index("by_hashed_ticket", ["hashedTicket"])
    .index("by_workspace_status", ["workspaceId", "status"])
    .index("by_workspace_updatedAt", ["workspaceId", "updatedAt"])
    .index("by_expiresAt", ["expiresAt"]),

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
   * Nine call sites now, and the two that shape this table are the ones a
   * **stranger** can drive: email ingestion resolve, and dynamic client
   * registration. See `lib/rateLimit.ts` for what the scheme does and does not
   * protect against.
   *
   * Holds no identity of its own: the key is a caller-built string, and the
   * row carries a count and a timestamp and nothing else.
   *
   * ## Why this table is swept, when the counters are tiny
   *
   * **The key is chosen by whoever is being limited**, so on an unauthenticated
   * route the keyspace is theirs and not ours. `ingestionGateway.ts` handles
   * that by counting *after* the lookups, which bounds its keys to names that
   * belong to real contexts. Registration cannot: it has nothing to look up,
   * so its key is derived from the caller's network, and somebody who holds
   * many networks holds many keys.
   *
   * Normalising an address to its /64 collapses the cheap part of that — one
   * customer's 2^64 addresses become one bucket — and the sweep bounds the
   * rest, by *rate* rather than by keyspace: a row whose window closed carries
   * no information, so it is garbage rather than state. Without the sweep the
   * limit intended to stop unbounded rows would add a second unbounded table,
   * which is measured in `__tests__/controlPlane.test.ts`.
   */
  rateLimits: defineTable({
    key: v.string(),
    windowStartedAt: v.number(),
    count: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_windowStartedAt", ["windowStartedAt"]),

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
  /**
   * Assets the *product* needs, in our own storage rather than a customer's.
   *
   * Exactly one row today: the card renderer's wasm. It is here because Convex
   * bundles JavaScript and not a package's `.wasm`, so a `require.resolve` of it
   * deploys cleanly and throws at runtime — and 3.15 MB of base64 in a source
   * module is the alternative.
   *
   * **Nothing customer-owned belongs in this table.** Their bytes live in their
   * bucket; that is non-negotiable #1. This is a build artifact of ours that
   * happens to need somewhere to sit.
   */
  renderAssets: defineTable({
    kind: v.literal("resvgWasm"),
    storageId: v.id("_storage"),
    updatedAt: v.number(),
  }),

  /**
   * A wasm install in progress, in pieces. Empty except during one.
   *
   * Exists because `convex run` cannot take 3.15 MB of base64 in an argument
   * and has no stdin form — see `installWasm`. Rows are deleted the moment they
   * are assembled.
   */
  renderAssetChunks: defineTable({
    index: v.number(),
    total: v.number(),
    chunk: v.bytes(),
  }),

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

  /**
   * Whether a context's search is served from a database Supa Media owns, and
   * which one.
   *
   * ## A row exists only because somebody asked for one
   *
   * **There is no row for a context that has not opted in.** Not a row with
   * `optedIn: false` — no row. That is the difference between a table of
   * every customer's preference and a table of the customers who said yes,
   * and it is the shape that makes "we hold a derived copy of your notes only
   * where you asked us to" checkable by counting rows.
   *
   * A row appears when an owner turns the switch on and is **deleted**, along
   * with the database it names, when they turn it off. A switch labelled off
   * that leaves the derived copy in place is the switch not working.
   *
   * ## What this is not
   *
   * Not a storage binding. `storageBindings` points at the customer's own
   * bucket, holds their credential, and is the canonical store; this points at
   * a database *we* own holding a disposable derivative, and holds no customer
   * credential at all. Deleting every row here costs a rebuild and loses
   * nothing (CLAUDE.md, "Plain files stay canonical"). Deleting a storage
   * binding disconnects somebody's brain.
   *
   * The reasoning for the two-condition gate is in `functions/lib/fastSearch.ts`.
   */
  searchIndexes: defineTable({
    workspaceId: v.id("workspaces"),
    /**
     * Which product contract created this derivative.
     *
     * Rows written before Premium launched have no generation and are never
     * served. A paid opt-in replaces their remote coordinates and provisions a
     * fresh database in the customer-data account; the files remain canonical.
     */
    generation: v.optional(v.literal("premium-v1")),
    /**
     * The owner's answer, and the reason the row exists.
     *
     * Stored rather than implied by the row's existence because the two come
     * apart for exactly one moment: an opt-out that has written the row's
     * intent but not yet finished deleting the remote database. A reader
     * during that window must serve the R2 index, and `optedIn: false` is how
     * it knows to.
     */
    optedIn: v.boolean(),
    /** Who turned it on, and when. Recorded because it is a consent decision. */
    optedInBy: v.id("users"),
    optedInAt: v.number(),
    /**
     * `provisioning` → creating the remote database and applying the schema.
     * `backfilling` → schema applied, notes still being projected.
     * `ready`       → serving.
     * `failed`      → provisioning did not complete; `error` says why.
     * `releasing`   → opted out, database not yet deleted. Serves nothing.
     */
    status: v.union(
      v.literal("provisioning"),
      v.literal("backfilling"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("releasing"),
    ),
    /**
     * Cloudflare's uuid for the database, once it exists.
     *
     * Configuration, not a secret: reaching it still requires the API token,
     * which lives in `appSecrets` and never here. Absent until created, and
     * the thing a release has to delete — a row that loses this before the
     * remote database is gone is a database nothing will ever clean up, which
     * is why `releasing` keeps it until the delete succeeds.
     */
    databaseId: v.optional(v.string()),
    databaseName: v.optional(v.string()),
    /** The projection schema version applied, for forward migrations. */
    schemaVersion: v.optional(v.number()),
    /** Ours, from a closed set — never a provider's text. */
    errorCode: v.optional(v.string()),
    /** Operator-facing detail, shown to the owner. Never a credential. */
    error: v.optional(v.string()),
    /** Backfill progress, so the settings screen can be honest about it. */
    notesIndexed: v.optional(v.number()),
    notesPending: v.optional(v.number()),
    /**
     * Where provisioning the managed bucket has got to, for the one context
     * this plan is for.
     *
     * On the plan rather than on the binding, because until it succeeds there
     * *is* no binding — and the screen that has to say "creating your storage"
     * is looking at somebody who has paid and has nothing yet. Absent is the
     * ordinary state: a context that never bought managed storage has no
     * answer here and needs none.
     *
     * `failed` is the state that has to exist. Without it the console can only
     * wait, and a person who paid two minutes ago cannot tell a slow webhook
     * from a bucket that will never appear.
     */
    managedProvisioning: v.optional(
      v.union(v.literal("running"), v.literal("ready"), v.literal("failed")),
    ),
    /**
     * Why it failed, from **our** closed set — never Cloudflare's text, which
     * can name an account. The console maps it to a sentence and a next step.
     */
    managedProvisioningError: v.optional(v.string()),
    /** When the last attempt ended, so a retry can be rate-limited by a human. */
    managedProvisioningAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    /** For the sweep that finishes releases and retries failures. */
    .index("by_status", ["status"]),

  /**
   * What staff did on the platform, as opposed to what a member did in a
   * context.
   *
   * Deliberately **not** `auditEvents`. That table is a customer-facing record
   * scoped to one workspace, readable by that workspace's members and shown in
   * their console; an admin setting a Stripe key belongs to neither a
   * workspace nor a customer, and folding it in would either make
   * `workspaceId` optional — weakening every per-workspace query that relies
   * on it being present — or attribute a platform act to whichever context
   * happened to be on screen.
   *
   * The rule the two tables share: **paths and names, never values.** A row
   * here records that `SEARCH_D1_API_TOKEN` was set and by whom. It never
   * records what it was set to, and the fingerprint is the most this table
   * will ever carry of a secret.
   */
  adminAuditEvents: defineTable({
    actorUserId: v.id("users"),
    /** The address that matched the allowlist, kept for a readable trail. */
    actorEmail: v.string(),
    /** A closed vocabulary — see `functions/admin.ts`. */
    action: v.string(),
    /** The secret's name, a metric name, a workspace slug. Never a value. */
    subject: v.optional(v.string()),
    at: v.number(),
    details: v.optional(
      v.record(
        v.string(),
        v.union(v.string(), v.number(), v.boolean(), v.null()),
      ),
    ),
  })
    .index("by_at", ["at"])
    .index("by_actor_at", ["actorUserId", "at"]),

  /**
   * Integration credentials the platform itself holds.
   *
   * Not a customer's credential — those are `storageBindings`, bound to a
   * workspace and openable in that workspace's row alone. These belong to
   * Context.LC: the Cloudflare token that provisions search databases, a
   * payment provider's key, a mail provider's key. One row per name.
   *
   * ## What may never live here
   *
   * **`STORAGE_SECRET_ENCRYPTION_KEY` and `GATEWAY_SECRET` stay environment
   * variables, permanently.** The first is the key these envelopes are sealed
   * with, so storing it here is a safe whose combination is written inside it;
   * the second is what proves a caller is the gateway, and the gateway must be
   * able to authenticate before any database read is trusted. Anything that
   * has to exist *before* this table can be read cannot be kept in it.
   * `functions/admin.ts` enforces that as a refused name rather than a comment.
   *
   * ## Write-only, structurally
   *
   * `encryptedValue` is an AES-GCM envelope bound to the `integration` scope
   * (`lib/crypto.ts`). No public function may reach `decryptSecret` — that is
   * `__tests__/structure.test.ts`, and it is what makes "the console can set a
   * secret but never read one back" a property of the codebase rather than a
   * habit of its screens. The admin UI renders `fingerprint`, which is
   * computed at write time from the plaintext and is not reversible.
   */
  appSecrets: defineTable({
    /**
     * The environment-variable-style name, e.g. `SEARCH_D1_API_TOKEN`.
     * Uppercase, digits and underscores; validated on write, unique by index.
     */
    name: v.string(),
    /**
     * `v2:<key-id>:<iv>:<ciphertext>`, bound to the `integration` scope.
     *
     * Named `encrypted*` deliberately, and not for style:
     * `__tests__/structure.test.ts` derives `SCHEMA_ENCRYPTED_FIELDS` by
     * matching that prefix, and forbids any of them appearing in a public
     * function's `returns:` validator "with nobody needing to remember". A
     * column called `value` sits outside that promise — inert today, since
     * these functions declare no return validator, and a trap the moment one
     * does.
     */
    encryptedValue: v.string(),
    /**
     * First 8 hex characters of SHA-256 over the plaintext.
     *
     * Enough to confirm that the value you pasted is the value that landed,
     * and to tell two credentials apart, without being the credential. Not a
     * prefix or a last-four of the secret itself: those are fragments of the
     * real thing, and this needs to be safe to render on a screen and put in
     * a log line.
     */
    fingerprint: v.string(),
    /** What this is for, shown in the console. Never the value. */
    description: v.optional(v.string()),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
    createdAt: v.number(),
  }).index("by_name", ["name"]),

  /**
   * Daily product usage, as counters.
   *
   * ## Counters, not events, and the reason is the first non-negotiable
   *
   * An event log with one row per tool call would be a second record of what
   * somebody did in their own context, held by us — and the audit trail that
   * legitimately records that already exists, in the customer's own bucket
   * under `.audit/`, where they can read and delete it. Mining that to build
   * our dashboards would quietly turn a customer-owned record into a
   * product-analytics pipeline, which is exactly the move CLAUDE.md's first
   * rule forbids.
   *
   * So this table holds **integers per day per metric**, incremented in place.
   * There is no path column, no query text, no note title, no timestamp finer
   * than the day, and no shape into which any of those could later be added
   * without an obvious schema change and a conversation.
   *
   * `workspaceId` is optional and present only for metrics that are counted
   * per context (tool calls). Where it is set, the row says "this workspace
   * made N calls on this day" — which is metadata we already hold, of the same
   * kind as a member list, and never what the calls were about.
   */
  usageDaily: defineTable({
    /** `YYYY-MM-DD`, UTC. The bucket, and half the identity of the row. */
    day: v.string(),
    /** A `UsageMetric` from `lib/usage.ts` — a closed set, never free text. */
    metric: v.string(),
    /** Set only for per-context metrics; absent for platform-wide ones. */
    workspaceId: v.optional(v.id("workspaces")),
    count: v.number(),
    updatedAt: v.number(),
  })
    .index("by_day_metric", ["day", "metric"])
    .index("by_day_metric_workspace", ["day", "metric", "workspaceId"])
    .index("by_metric_day", ["metric", "day"]),

  /**
   * One row per workspace per day that did anything, so "active" is countable.
   *
   * Kept apart from `usageDaily` because an active-user count is a
   * **cardinality**, not a sum: incrementing a counter per call answers "how
   * many calls", and no arithmetic over that answers "how many distinct
   * contexts". The alternative — reading every counter row for a day and
   * counting the distinct workspaces — is the same data, so this table exists
   * only to make the common query a cheap range read rather than a scan.
   *
   * Rows carry no activity detail. That a context was active on a day is the
   * entire content.
   */
  usageActiveDaily: defineTable({
    day: v.string(),
    workspaceId: v.id("workspaces"),
    /** Which surface saw it — `UsageSurface` from `lib/usage.ts`. */
    surface: v.string(),
    at: v.number(),
  })
    .index("by_day", ["day"])
    .index("by_day_surface", ["day", "surface"])
    .index("by_day_surface_workspace", ["day", "surface", "workspaceId"]),

  /**
   * What one context pays for.
   *
   * **Keyed by `workspaceId`, never by `userId`**, exactly as a storage
   * binding is and for the same reason (`CLAUDE.md`, "The workspace model"):
   * you are upgrading a bucket, not a person. One person may hold a free
   * personal brain and a paid work workspace on a work card, and each is one
   * row and one subscription. A `userId` here would make the second of those
   * impossible to express and the first impossible to keep free.
   *
   * **A row exists only where somebody chose something.** No row is the
   * ordinary state and means free, no entitlements, no Stripe customer — so
   * "how many contexts are paying" is a count rather than a filter, the same
   * shape `searchIndexes` uses.
   *
   * **Nothing here gates the exit.** There is no export flag, no quota and no
   * expiry attached to one: downloading everything, or handing the bucket to
   * storage of their own, is free, identical on both plans, and works after a
   * cancellation (non-negotiable #1). `__tests__/premium.test.ts` fails on a
   * field shaped like one.
   */
  workspacePlans: defineTable({
    workspaceId: v.id("workspaces"),
    /**
     * What the owner asked for, stored whether or not anybody is paying.
     *
     * Kept apart from what is *active* so a lapsed subscription can be resumed
     * with a payment rather than a re-selection — the same "asked for" /
     * "entitled" separation `lib/fastSearch.ts` argues at length. Nothing reads
     * these two directly to decide what a context gets: `activeEntitlements`
     * in `lib/premium.ts` is the one place that ANDs them with the status.
     */
    managedStorage: v.boolean(),
    fastSearch: v.boolean(),
    /**
     * Stripe's subscription status as this build understands it —
     * `planStatusFromStripe`, a closed set. A word we have never heard of
     * lands here as `unknown` and serves nothing; it is never read as
     * `active`, which would be an entitlement bought by a vocabulary change.
     */
    status: v.union(
      v.literal("none"),
      v.literal("active"),
      v.literal("past_due"),
      v.literal("canceled"),
      v.literal("unknown"),
    ),
    /**
     * Stripe's own identifiers, and deliberately **not credentials**: a
     * customer id and a subscription id decide nothing without the API key,
     * which lives in `appSecrets` and never here. They are what lets a later
     * event be reconciled to the context it belongs to without trusting an id
     * that arrived in the event body.
     */
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    /** Seconds, from Stripe. The end of the period already paid for. */
    currentPeriodEnd: v.optional(v.number()),
    /** True where Stripe says the subscription stops at the period end. */
    cancelAtPeriodEnd: v.optional(v.boolean()),
    /**
     * When Stripe created the newest event applied, in seconds, and **every**
     * event id applied at that second.
     *
     * Webhook delivery is at-least-once and out of order, and the two fields
     * answer the two halves of that: the timestamp drops anything created
     * before the newest applied, and the set drops a redelivery of anything
     * applied *at* it.
     *
     * ## Why a set and not one id
     *
     * One id plus a strict `<` left a hole precisely where Stripe stamps a
     * cancellation pair, because `updated` and `deleted` are emitted together
     * in the same second:
     *
     *   evt_upd (T, active)  applied → last id = evt_upd
     *   evt_del (T, deleted) applied → last id = evt_del, plan canceled
     *   evt_upd (T) retried  → a different id, and T < T is false → APPLIED,
     *                          and the cancelled plan is active again.
     *
     * A retry is freshly signed, so the signature's five-minute tolerance does
     * not bound it — it can arrive days later, anywhere in Stripe's retry
     * schedule. Widening the comparison to `<=` is not the fix either: it
     * drops the legitimate `deleted` when `updated` arrives first in the same
     * second, which is the ordinary ordering.
     *
     * So the set holds every id at `lastEventAt` and is **reset when the
     * second moves**, which is what keeps it bounded: its size is the number
     * of events Stripe emits for one subscription within one second.
     */
    lastEventIds: v.optional(v.array(v.string())),
    lastEventAt: v.optional(v.number()),
    /**
     * Where provisioning the managed bucket has got to, for the one context
     * this plan is for.
     *
     * On the plan rather than on the binding, because until it succeeds there
     * *is* no binding — and the screen that has to say "creating your storage"
     * is looking at somebody who has paid and has nothing yet. Absent is the
     * ordinary state: a context that never bought managed storage has no
     * answer here and needs none.
     *
     * `failed` is the state that has to exist. Without it the console can only
     * wait, and a person who paid two minutes ago cannot tell a slow webhook
     * from a bucket that will never appear.
     */
    managedProvisioning: v.optional(
      v.union(v.literal("running"), v.literal("ready"), v.literal("failed")),
    ),
    /**
     * Why it failed, from **our** closed set — never Cloudflare's text, which
     * can name an account. The console maps it to a sentence and a next step.
     */
    managedProvisioningError: v.optional(v.string()),
    /** When the last attempt ended, so a retry can be rate-limited by a human. */
    managedProvisioningAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    /** How a subscription event finds the context it belongs to. */
    .index("by_subscription", ["stripeSubscriptionId"]),

  /**
   * One attempt to open Stripe's hosted checkout or customer portal.
   *
   * The row exists because the URL cannot be returned from the mutation that
   * asks for it. Minting one needs the payment key, only an action may open a
   * credential, and a public action that awaited one would be a public
   * function reaching a decrypt — which `__tests__/structure.test.ts` refuses.
   * So the mutation writes a row and **schedules** the action ("scheduling is
   * not calling"), the action fills the row in, and the console watches the
   * row it was handed. Same shape as `cloudflareProvisioning`.
   *
   * The row holds a URL and no credential. Stripe's checkout URL is a
   * capability — anybody holding it can pay — so it is readable only by the
   * owner who started the attempt, and it expires.
   */
  billingSessions: defineTable({
    workspaceId: v.id("workspaces"),
    startedBy: v.id("users"),
    kind: v.union(v.literal("checkout"), v.literal("portal")),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    /** Stripe's hosted page, once it exists. */
    url: v.optional(v.string()),
    /**
     * What the owner had chosen when this attempt was opened.
     *
     * **What somebody paid for is what they chose at checkout**, not whatever
     * the toggles happen to say when the webhook lands minutes later. Stored
     * so a plan can never activate entitling nothing: if the live selection is
     * empty at activation, this is restored. Absent on a portal attempt, which
     * buys nothing.
     */
    selectedAtCheckout: v.optional(
      v.object({ managedStorage: v.boolean(), fastSearch: v.boolean() }),
    ),
    /**
     * Where the attempt started, which decides where finishing returns to.
     *
     * Optional because rows written before this existed have no answer, and
     * "settings" is the right reading of those: it is where the only checkout
     * the product had could be started from. Never taken from a client as a
     * URL — it selects one of two shapes we wrote, which is the same rule
     * `expectedWorkspaceId` follows at the gateway.
     */
    origin: v.optional(v.union(v.literal("settings"), v.literal("onboarding"))),
    /** Ours, from a closed set — never Stripe's text, which can name an account. */
    errorCode: v.optional(v.string()),
    /**
     * Short. An attempt nobody completed within a few minutes is a tab
     * somebody abandoned, and a live checkout URL is a live capability.
     */
    expiresAt: v.number(),
    /**
     * Where provisioning the managed bucket has got to, for the one context
     * this plan is for.
     *
     * On the plan rather than on the binding, because until it succeeds there
     * *is* no binding — and the screen that has to say "creating your storage"
     * is looking at somebody who has paid and has nothing yet. Absent is the
     * ordinary state: a context that never bought managed storage has no
     * answer here and needs none.
     *
     * `failed` is the state that has to exist. Without it the console can only
     * wait, and a person who paid two minutes ago cannot tell a slow webhook
     * from a bucket that will never appear.
     */
    managedProvisioning: v.optional(
      v.union(v.literal("running"), v.literal("ready"), v.literal("failed")),
    ),
    /**
     * Why it failed, from **our** closed set — never Cloudflare's text, which
     * can name an account. The console maps it to a sentence and a next step.
     */
    managedProvisioningError: v.optional(v.string()),
    /** When the last attempt ended, so a retry can be rate-limited by a human. */
    managedProvisioningAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_expiresAt", ["expiresAt"]),
});

export default schema;
