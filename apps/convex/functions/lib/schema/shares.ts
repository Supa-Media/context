import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Links an owner mints and can revoke.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const shareTables = {
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
     * Whether `entryPath` is one note or a folder whose subtree this reaches.
     *
     * **Optional, and absent means `note`** — every row written before folder
     * links existed is one, and a share's reach must never depend on a field
     * being backfilled. Stored rather than derived, because a path cannot be
     * told apart: `1-projects/transition` is a folder here and an
     * extensionless file somewhere else, and `checkTeamSharePath` already
     * records that "note or folder" was never implementable from the string.
     *
     * A folder share reaches what is **under** the prefix and is still
     * re-derived through the live `privacy.md` at `team` scope on every read,
     * so it publishes only what the manifest already published to the
     * workspace — a narrowing of the folder, never a widening. That is the one
     * place this is deliberately stricter than Drive, whose model is inherit
     * unless restricted. See "A folder link reaches a subtree" in
     * `docs/decisions/privacy-and-sharing.md`.
     */
    entryKind: v.optional(v.union(v.literal("note"), v.literal("folder"))),
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
    /**
     * The 32 random bytes in the share URL.
     *
     * **Unguessable, and for three of the four audiences useless without the
     * matching identity** — a `name`, `email` or `members` share resolves an
     * identity or a membership before it answers, so the token is a locator
     * and the reader is authorised by who they are.
     *
     * For `anyone` it is not a locator. `authorizeShareRead` takes
     * `actorUserId: null` and `shareStillStands` answers for an unlisted
     * share, so **possession of this value is the whole authorization** —
     * which is the point of that audience and is argued under `recipientKind`
     * above. This comment used to claim the identity requirement without
     * qualification, which was true when it was written and stopped being true
     * when `anyone` was added; a field holding a live bearer credential must
     * not read as if it holds a locator.
     */
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
    /**
     * The owner-chosen name in a short link, `intake` in
     * `context.lc/@seyi/intake`, or absent for a link that has only its token.
     *
     * **A second locator for this row, never a second authorization.** The read
     * path resolves a slug to this row and then runs exactly the code the token
     * runs, so a short link grants what the share granted and dies when it is
     * revoked. What it changes is arrival: a token is handed to somebody, a
     * slug can also be guessed — which is stated to the owner before they claim
     * one and is the reason claiming is its own step. See `lib/shareSlug.ts`.
     *
     * Unique per workspace, enforced by a read through `by_workspace_slug`
     * before the write rather than by the index, which Convex does not
     * constrain. Freed when the share is revoked, because the alternative is a
     * name an owner cannot reuse on their own context.
     */
    slug: v.optional(v.string()),
    /**
     * What this link lets somebody do: read what it points at, or answer a
     * form on it. Absent means `read`, which is every row written before
     * collect mode and the only thing a link has ever done.
     *
     * **`collect` is the first write in this product that is not an
     * authenticated member.** Every other one resolves a grant or a session to
     * a person with a handle; this takes an answer from somebody who will
     * never have an account, which is what an intake form is and is a rule
     * this field changes rather than a surface it adds.
     *
     * What keeps it narrow is enforced in `collect.ts` rather than here, but
     * the shape is: only on an `anyone` row, only over a note, only into the
     * response file a form on that note already names, only where that form
     * takes `member` submissions, and never as a way to *read* the answers.
     */
    mode: v.optional(v.union(v.literal("read"), v.literal("collect"))),
    /**
     * How many answers this link may take in total, or absent for the default.
     *
     * An owner's own ceiling on a link they published. A rate limit stops a
     * flood; this stops a slow drip that fills a bucket over a week, and it is
     * per link rather than per context so that taking one down is not the only
     * lever.
     */
    collectCap: v.optional(v.number()),
    /**
     * Answers taken through this link so far, counted here rather than by
     * reading the responses file.
     *
     * The file is the canonical record and this is a counter beside it, which
     * is the one shape that would normally be wrong — two copies of one truth.
     * It is right here because the alternative is opening the customer's
     * bucket to decide whether to refuse, which means an unauthenticated
     * caller can make us spend a GET on their quota by posting garbage. The
     * counter is the cheap gate; the file stays the record, and a counter that
     * drifts low costs at most a few answers over the cap rather than
     * anything unrecoverable.
     */
    collectCount: v.optional(v.number()),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    /** The owner's own listing, narrowed in the index for `listInvitations`' reason. */
    .index("by_workspace_status", ["workspaceId", "status"])
    /**
     * A short link's whole lookup: the handle names the workspace, this names
     * the row. Live-ness is checked on the row, never in the index, so a
     * revoked slug answers exactly as a slug nobody ever claimed does.
     */
    .index("by_workspace_slug", ["workspaceId", "slug"])
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
};
