import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Named groups inside a workspace, and invitations to join one.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const membershipTables = {
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
};
