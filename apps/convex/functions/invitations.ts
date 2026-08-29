/**
 * Invitations — how a second person gets into a context.
 *
 * A workspace is the unit that owns a context, and a shared context is the same
 * row as a personal one with more membership. This module is the only thing
 * that creates that extra membership; `createWorkspace` writes the creator's
 * `owner` row and nothing else in the codebase inserts into `workspaceMembers`.
 *
 * ## An invitation is now delivered, and that changed one sentence and no rules
 *
 * This module used to say that `listMyInvitations` was the only delivery
 * channel, and that nothing here sent email. Both were true and neither is any
 * more: `inviteMember` schedules `functions/invitationEmail.ts`, which mails an
 * `email` invitee a link.
 *
 * What did **not** change is why that sentence used to be here. It was never a
 * statement that delivery was undesirable — it was the observation that the
 * only channel available was one the invitee had to already have an account to
 * read, and that `inviteMember` could not be allowed to acquire a second one
 * that told the *inviter* anything. The send is therefore scheduled rather than
 * called, so it has no return value, no exception, and no latency the inviter
 * can observe; and it happens only for an `email` invitee, so no `@name` is
 * ever resolved to a person at invite time. `listMyInvitations` remains the
 * channel for a `@name` invitation and the fallback for every address, because
 * mail is not guaranteed and an invitation must be answerable without it.
 *
 * The four mechanisms below are unchanged, and every one of them still holds
 * with a send attached.
 *
 * ## An invitation must not be an existence oracle
 *
 * This is the property the whole module is shaped around, and it is easy to
 * lose. The threat is not a stranger — it is the **inviter**. Anybody with an
 * account can create a workspace and type identifiers into its invite box, so
 * if the outcome of inviting `@does-not-exist` differed in *any* observable way
 * from inviting `@lk`, an invite box would be a name-enumeration endpoint, and
 * `@name` is also a future subdomain and a mail address (`<name>@context.lc`).
 * The control plane's byte-identical `WORKSPACE_NOT_FOUND`, and the frozen link
 * previews, exist to close exactly this; an invite box that leaks it would undo
 * both.
 *
 * Four mechanisms hold the line, and each one is load-bearing:
 *
 *  1. **The invitation is addressed to a string, not to a person.**
 *     `inviteMember` writes the row before it knows, and without asking,
 *     whether anybody answers to that identifier. Resolution happens on the way
 *     *in*, at accept time.
 *  2. **`inviteMember` returns `null`.** Not an id, not a token, not a
 *     "delivered" flag — there is no field for a difference to hide in.
 *  3. **A refusal is only ever about the string.** `parseInvitee` is pure and
 *     cannot reach a database (see `lib/invitees.ts`), so no rejection can be
 *     conditioned on who exists.
 *  4. **`listInvitations` shows pending invitations and nothing else.** A
 *     decline, a revocation and an expiry all render as the same absence, so
 *     answering "no" discloses nothing — and re-inviting somebody who declined
 *     produces one pending row, identical in every field but the identifier to
 *     inviting somebody who does not exist. There is no `declined` state for an
 *     inviter to read.
 *
 * The one thing that *is* allowed to differ is inviting somebody already in the
 * workspace: that is a no-op with no row. It leaks nothing, because the caller
 * is an owner and `listMembers` already tells them exactly who their members
 * are — they cannot learn a fact they could not already enumerate.
 *
 * ## Ownership is not transferable here
 *
 * `role` is `editor` or `member`, enforced by the argument validator, so
 * `inviteMember` structurally cannot mint an owner. Handing a context to
 * somebody else — with its storage credential, its audit trail, and the power
 * to remove the person handing it over — is a deliberate act that deserves its
 * own confirmation flow, and is not built. Do not add `owner` to the union as a
 * shortcut to it.
 */

import { ConvexError, v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { internal } from "../_generated/api";
import { internalMutation, mutation, query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { invalidateInvitationSignInCode } from "./invitationEmail";
import { recordAudit } from "./lib/audit";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { identifiersForUser, resolveAddressedUser } from "./lib/identities";
import {
  formatInvitee,
  inviteeRejectionError,
  parseInvitee,
  type Invitee,
} from "./lib/invitees";
import { findName } from "./lib/nameClaims";
import { consumeRateLimit } from "./lib/rateLimit";
import {
  getMembership,
  requireWorkspaceAccess,
  requireWorkspaceRole,
} from "./lib/workspaceAuth";

/**
 * How long an invitation stays answerable.
 *
 * A week: long enough to survive a holiday, short enough that a link forwarded
 * into a group chat two months ago is dead. Expiry is enforced on every read
 * and every write, never by the sweep — see `purgeExpiredInvitations`.
 */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an expired row is kept before the sweep takes it.
 *
 * Not zero, for the reason `oauthAuthorizations` gives: deleting a row the
 * instant it expires races an acceptance already in flight, and the difference
 * between "expired" and "never existed" is nothing a caller can see anyway.
 */
const INVITATION_RETENTION_MS = 60 * 60 * 1000;

/** One sweep moves at most this many rows, so a backlog cannot blow a limit. */
const SWEEP_BATCH_SIZE = 200;

/**
 * Caps on how many rows one response carries, and on how many invitations one
 * context may have outstanding.
 *
 * An unbounded `.collect()` is a read whose cost is set by whoever can insert
 * rows. The pending cap additionally bounds the *table*: combined with
 * supersession — at most one row ever exists per `(workspace, invitee)` — it
 * means a context's invitation history is proportional to the number of
 * distinct people it has tried to invite, not to how many times it tried.
 */
const MAX_INVITATIONS_RETURNED = 200;
const MAX_PENDING_INVITATIONS = 100;

/**
 * The two numbers above are related, and the relationship is what makes the
 * bounded read correct rather than merely cheap.
 *
 * Both the listing and the cap read `by_workspace_status` narrowed to
 * `pending`, so the window holds live invitations plus those that have expired
 * and have not yet been swept. The cap keeps the live ones under a hundred and
 * the daily sweep keeps the expired ones to roughly a day's worth, so the
 * two-hundred-row window has real headroom. It is headroom, not a proof: a
 * context that let several hundred invitations expire inside one sweep interval
 * would stop showing the tail of its list. That is a display gap, not a
 * disclosure, and it corrects itself the next time the sweep runs.
 */

/** Invitations one account may successfully create per hour, across all contexts. */
const INVITE_LIMIT = 20;
const INVITE_WINDOW_MS = 60 * 60 * 1000;

/**
 * One error for "no such invitation", "not yours", "already answered", and
 * "expired".
 *
 * Same discipline as `workspaceNotFound()` and `grantNotFound()`, and here it
 * is the *whole* authorization story rather than a refinement of it: a token is
 * the only handle on an invitation, so an error that distinguished "real but
 * addressed to somebody else" from "never existed" would confirm a guessed
 * token, and one that distinguished "already accepted" from "unknown" would
 * turn a spent invitation into a probe. Accepting one you were not sent must
 * fail exactly like accepting one that was never issued.
 */
function invitationNotFound(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "INVITATION_NOT_FOUND",
    message: "Invitation not found",
  });
}

/** Whether an invitation is answerable right now. */
function isPending(invitation: Doc<"workspaceInvitations">, now: number): boolean {
  return invitation.status === "pending" && invitation.expiresAt > now;
}

/**
 * The one row an invitation to this identifier would occupy, if any.
 *
 * `.unique()` is safe because every write goes through this lookup first, and
 * Convex mutations are serializable: a second insert for the same triple reads
 * the same index range, so the loser's transaction conflicts and re-runs. Same
 * argument `claimName` relies on for the global namespace.
 */
async function findInvitationFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  invitee: Invitee,
): Promise<Doc<"workspaceInvitations"> | null> {
  return await ctx.db
    .query("workspaceInvitations")
    .withIndex("by_invitee", (q) =>
      q
        .eq("inviteeKind", invitee.kind)
        .eq("invitee", invitee.value)
        .eq("workspaceId", workspaceId),
    )
    .unique();
}

/**
 * Resolve a presented token to the invitation it addresses to *this* caller.
 *
 * Every refusal is `invitationNotFound()`, constructed once, so the four
 * different reasons are one answer. The row is read first because the token is
 * the only handle there is — but nothing read from it reaches the caller unless
 * every check passes.
 *
 * Note the order: `status` and `expiresAt` are checked before the identity is
 * resolved. That costs a caller holding a spent token nothing they could
 * observe, and it means the identity lookup — the only part that reads other
 * tables — never runs for a token that was already dead.
 *
 * ## The one asymmetry, and why it is not the `workspaceAuth` situation
 *
 * An unknown token reads one table; a live token addressed to somebody else
 * reads two or three more. That is a timing difference, and it is deliberately
 * left alone. `requireWorkspaceAccess` equalizes its reads because workspace
 * ids are guessable and harvestable — an attacker can *get* one to time. A
 * token is 32 random bytes from `crypto.getRandomValues`, so reaching the
 * second path at all requires already holding a real one, and somebody who
 * holds a real one learns nothing from how long the refusal took. Equalizing
 * here would mean issuing reads for values that cannot occur, which is cost
 * without a threat.
 */
async function resolveInvitationForCaller(
  ctx: QueryCtx,
  token: string,
  userId: Id<"users">,
  now: number,
): Promise<Doc<"workspaceInvitations">> {
  const invitation = await ctx.db
    .query("workspaceInvitations")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (invitation === null) throw invitationNotFound();
  if (!isPending(invitation, now)) throw invitationNotFound();

  const addressed = await resolveAddressedUser(ctx, {
    kind: invitation.inviteeKind,
    value: invitation.invitee,
  });
  if (addressed === null || addressed !== userId) throw invitationNotFound();

  return invitation;
}

const pendingInvitation = v.object({
  invitationId: v.id("workspaceInvitations"),
  /** Decorated for display: `@lk`, or a bare address. */
  invitee: v.string(),
  role: v.string(),
  invitedBy: v.id("users"),
  createdAt: v.number(),
  expiresAt: v.number(),
});

/**
 * Invite somebody into this context, as an `editor` or a `member`.
 *
 * Owner-only. An `editor` can write notes; that is not the same as being able
 * to decide who else reads them, and a `member` is read-only.
 *
 * Returns `null` in every case that is not a refusal about the string itself —
 * whether the identifier belongs to somebody, to nobody, or to somebody who
 * already declined a previous invitation, and whether this call created a row,
 * replaced one, or deliberately did nothing. See the module docstring.
 *
 * Re-inviting supersedes: the previous row is rewritten with a fresh token,
 * role and expiry rather than joined by a second one. That keeps at most one
 * row per `(workspace, invitee)`, retires the old token, and — the point —
 * leaves a person who declined indistinguishable from a person who was never
 * invited.
 */
export const inviteMember = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    /** A `@name`, a bare name, or an email address. */
    invitee: v.string(),
    /**
     * Never `owner`. The validator is the enforcement — a handler check could
     * be relaxed by somebody who did not read why it was there.
     */
    role: v.union(v.literal("editor"), v.literal("member")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

    // Pure, and deliberately before any lookup: a refusal here is about the
    // string and could not have been about who exists.
    const parsed = parseInvitee(args.invitee);
    if (!parsed.ok) throw inviteeRejectionError(parsed.reason);

    // Counts commits, not attempts, like every other use of this limiter — a
    // rejected invite takes nothing. Scoped to the account rather than the
    // workspace so somebody cannot buy more budget by making more contexts.
    await consumeRateLimit(ctx, {
      key: `invitation.create:${userId}`,
      limit: INVITE_LIMIT,
      windowMs: INVITE_WINDOW_MS,
    });

    const now = Date.now();

    // The one permitted asymmetry. An owner can already enumerate their own
    // members, so doing nothing here tells them nothing `listMembers` did not.
    const existing = await resolveAddressedUser(ctx, parsed.invitee);
    if (existing !== null) {
      const membership = await getMembership(ctx, args.workspaceId, existing);
      if (membership !== null) return null;
    }

    const superseded = await findInvitationFor(ctx, args.workspaceId, parsed.invitee);

    if (superseded === null) {
      const outstanding = await ctx.db
        .query("workspaceInvitations")
        .withIndex("by_workspace_status", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("status", "pending"),
        )
        .take(MAX_INVITATIONS_RETURNED);
      if (outstanding.filter((row) => isPending(row, now)).length >= MAX_PENDING_INVITATIONS) {
        throw new ConvexError({
          code: "INVITATION_LIMIT_REACHED",
          message: `A context can have at most ${MAX_PENDING_INVITATIONS} invitations outstanding.`,
          limit: MAX_PENDING_INVITATIONS,
        });
      }
    }

    const offer = {
      role: args.role,
      invitedBy: userId,
      token: randomOpaqueToken(32),
      status: "pending" as const,
      expiresAt: now + INVITATION_TTL_MS,
      createdAt: now,
      respondedAt: undefined,
      // A superseding offer is a new offer: new token, new expiry, and the
      // right to be emailed once more. Leaving the old `emailSentAt` in place
      // would silently make re-inviting somebody a no-op in the inbox.
      emailSentAt: undefined,
    };

    let invitationId: Id<"workspaceInvitations">;
    if (superseded === null) {
      invitationId = await ctx.db.insert("workspaceInvitations", {
        workspaceId: args.workspaceId,
        inviteeKind: parsed.invitee.kind,
        invitee: parsed.invitee.value,
        ...offer,
      });
    } else {
      await ctx.db.patch(superseded._id, offer);
      invitationId = superseded._id;
    }

    // The identifier is the owner's own input and is already in
    // `listInvitations`; recording it names *who* was offered access, which is
    // the question an audit trail exists to answer.
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "member.invited",
      details: { invitee: formatInvitee(parsed.invitee), role: args.role },
    });

    // SCHEDULED, NEVER CALLED — and the difference is the oracle defence, not a
    // performance note. `ctx.scheduler.runAfter` enqueues a job in a separate
    // transaction whose return value the scheduler discards, so nothing about
    // whether that mailbox exists, whether Resend accepted it, or how long the
    // attempt took can reach this handler. A `ctx.runAction` here would put all
    // three inside the inviter's own call: a value they could read, an
    // exception they could catch, and a latency they could time without either.
    // See CLAUDE.md, "Scheduling is not calling", and the docstring of
    // `functions/invitationEmail.ts`.
    //
    // Only for an address. A `@name` has no mailbox we know of, and finding one
    // would mean resolving an identifier to a person at invite time, which is
    // the thing this whole module declines to do.
    if (parsed.invitee.kind === "email") {
      await ctx.scheduler.runAfter(
        0,
        internal.functions.invitationEmail.sendInvitationEmail,
        { invitationId, inviteeKind: parsed.invitee.kind },
      );
    }

    return null;
  },
});

/**
 * The invitations this context is still waiting on.
 *
 * Scoped to members, like `listMembers`: in a shared context, "who else has
 * been offered access" is a question the people already in it need answered.
 *
 * **Pending and unexpired only, and that is a security decision rather than a
 * convenience.** A declined invitation is an affirmative act by the invitee; if
 * it were visible here, an inviter could learn which of a list of guessed
 * handles belong to real people who bothered to say no. Rendering a decline, a
 * revocation and an expiry as the same absence means the only thing an inviter
 * ever learns is that somebody joined.
 *
 * The token is not in the response under any role. The only person who gets it
 * is the invitee, through `listMyInvitations`.
 */
export const listInvitations = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(pendingInvitation),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceAccess(ctx, args.workspaceId, userId);

    const now = Date.now();
    const rows = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("status", "pending"),
      )
      .take(MAX_INVITATIONS_RETURNED);

    return rows
      .filter((row) => isPending(row, now))
      .map((row) => ({
        invitationId: row._id,
        invitee: formatInvitee({ kind: row.inviteeKind, value: row.invitee }),
        role: row.role,
        invitedBy: row.invitedBy,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  },
});

/**
 * Take an outstanding invitation back. Owner-only.
 *
 * A `member` or an `editor` gets `INSUFFICIENT_ROLE` rather than
 * `INVITATION_NOT_FOUND`, and the difference from `revokeGrant`'s rule is
 * deliberate: `listInvitations` shows every member every pending invitation, so
 * a non-owner already knows the id is real and naming the missing role
 * discloses nothing they could not see. A caller who is not a member of the
 * workspace at all does get `INVITATION_NOT_FOUND`, byte-identical to an id
 * that never existed.
 */
export const revokeInvitation = mutation({
  args: { invitationId: v.id("workspaceInvitations") },
  returns: v.object({ revoked: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

    const invitation = await ctx.db.get(args.invitationId);
    if (invitation === null) throw invitationNotFound();

    const membership = await getMembership(ctx, invitation.workspaceId, userId);
    // Not a member of the invitation's workspace: indistinguishable from an
    // invitation id that never existed.
    if (membership === null) throw invitationNotFound();
    if (membership.role !== "owner") {
      throw new ConvexError({
        code: "INSUFFICIENT_ROLE",
        message: "Only a workspace owner can withdraw an invitation.",
        requiredRole: "owner",
        actualRole: membership.role,
      });
    }

    const now = Date.now();
    if (!isPending(invitation, now)) return { revoked: false };

    await ctx.db.patch(args.invitationId, { status: "revoked", respondedAt: now });
    // Withdrawing the offer withdraws the credential it mailed. Leaving the
    // magic-link code live for the rest of its 24 hours would mean an owner who
    // revoked an invitation had revoked the half that is visible in the console
    // and none of the half sitting in the invitee's inbox.
    await invalidateInvitationSignInCode(ctx, invitation);
    await recordAudit(ctx, {
      workspaceId: invitation.workspaceId,
      actorUserId: userId,
      action: "invitation.revoked",
      details: {
        invitee: formatInvitee({
          kind: invitation.inviteeKind,
          value: invitation.invitee,
        }),
      },
    });

    return { revoked: true };
  },
});

/**
 * The invitations addressed to the caller.
 *
 * The in-app delivery channel, and the only one for a `@name` invitation.
 * `inviteMember` cannot hand the token to the inviter — a return value that
 * varied with anything would be the oracle this module exists to prevent — so
 * the invitee reading their own invitations is how a token reaches the person
 * it was issued for.
 *
 * An `email` invitee is additionally mailed a link (see
 * `functions/invitationEmail.ts`), but this query is not a fallback for that
 * and must not become one. Mail is best-effort by nature: it is dropped when
 * the inviter's own address is unverified, dropped when the deployment has no
 * Resend key, sent at most once per row, and may simply not arrive. An
 * invitation has to be answerable by the person it was addressed to regardless,
 * and this is how.
 *
 * Every row is re-checked through `resolveInvitationForCaller`, the same
 * function `acceptInvitation` uses, rather than trusting the identifiers this
 * query gathered. That is not belt-and-braces for its own sake: the "which
 * identifiers are mine" direction and the "who does this identifier resolve to"
 * direction are different pieces of code, and if they ever disagree, the
 * failure must be a missing row here rather than an invitation that appears in
 * a list and then refuses to be accepted.
 */
export const listMyInvitations = query({
  args: {},
  returns: v.array(
    v.object({
      /** Single-use, expiring, and useless to anybody who is not the invitee. */
      token: v.string(),
      workspaceId: v.id("workspaces"),
      slug: v.string(),
      displayName: v.string(),
      role: v.string(),
      invitedBy: v.id("users"),
      createdAt: v.number(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const now = Date.now();

    // Candidates only. `resolveAddressedUser` below is the authority, and
    // anything gathered here that it disagrees with is dropped.
    const identifiers = await identifiersForUser(ctx, userId);

    const rows: Doc<"workspaceInvitations">[] = [];
    for (const identifier of identifiers) {
      const found = await ctx.db
        .query("workspaceInvitations")
        .withIndex("by_invitee", (q) =>
          q.eq("inviteeKind", identifier.kind).eq("invitee", identifier.value),
        )
        .take(MAX_INVITATIONS_RETURNED);
      rows.push(...found.filter((row) => isPending(row, now)));
    }

    const summaries = [];
    for (const row of rows) {
      // The authority, not the gathering above.
      const addressed = await resolveAddressedUser(ctx, {
        kind: row.inviteeKind,
        value: row.invitee,
      });
      if (addressed !== userId) continue;

      const workspace = await ctx.db.get(row.workspaceId);
      if (workspace === null) continue;
      summaries.push({
        token: row.token,
        workspaceId: workspace._id,
        slug: workspace.slug,
        displayName: workspace.displayName,
        role: row.role,
        invitedBy: row.invitedBy,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      });
    }
    return summaries.sort((a, b) => a.createdAt - b.createdAt);
  },
});

/**
 * Accept an invitation and become a member.
 *
 * Single-use by construction: the row is moved out of `pending` **in the same
 * transaction that read it**, so two concurrent acceptances cannot both see a
 * pending row, and a second attempt with the same token fails exactly like a
 * token that never existed.
 *
 * Already being a member is not an error and does not change the existing role.
 * An `owner` who is somehow re-invited as a `member` must not be demoted by
 * clicking a link, and re-adding somebody who is already there is not something
 * the person accepting should be made to reason about — the invitation is spent
 * and their standing is untouched.
 */
export const acceptInvitation = mutation({
  args: { token: v.string() },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    slug: v.string(),
    role: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const now = Date.now();

    const invitation = await resolveInvitationForCaller(ctx, args.token, userId, now);
    const workspace = await ctx.db.get(invitation.workspaceId);
    // An invitation to a context that no longer exists is not answerable, and
    // the caller learns only what they already knew: this token does nothing.
    if (workspace === null) throw invitationNotFound();

    // Spend it first. Everything after this is idempotent, so a retry that
    // races itself joins once.
    await ctx.db.patch(invitation._id, { status: "accepted", respondedAt: now });
    // The link has been answered, by somebody who is signed in as we speak, so
    // the code it carried has no remaining job. Leaving it would be a standing
    // credential in a mail archive outliving the thing it was minted for.
    await invalidateInvitationSignInCode(ctx, invitation);

    const existing = await getMembership(ctx, workspace._id, userId);
    if (existing !== null) {
      return { workspaceId: workspace._id, slug: workspace.slug, role: existing.role };
    }

    await ctx.db.insert("workspaceMembers", {
      workspaceId: workspace._id,
      userId,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
      joinedAt: now,
    });

    await recordAudit(ctx, {
      workspaceId: workspace._id,
      actorUserId: userId,
      action: "member.joined",
      details: { role: invitation.role, invitedBy: invitation.invitedBy },
    });

    return { workspaceId: workspace._id, slug: workspace.slug, role: invitation.role };
  },
});

/**
 * Decline an invitation.
 *
 * Spends the token, so a declined invitation cannot be replayed later by
 * somebody who kept the link.
 *
 * **Deliberately writes no audit event**, which is the one place this module
 * departs from "audit every membership change" — and it is not a membership
 * change. The audit trail is readable by every member of the workspace, so an
 * `invitation.declined` row would tell them that the identifier the owner typed
 * belongs to a real person who read it and said no. That is precisely the
 * disclosure `listInvitations` refuses to make, reached through a different
 * door. An owner sees the invitation stop being pending; a decline, a
 * revocation, an expiry and an invitation nobody could ever answer are the same
 * observation.
 */
export const declineInvitation = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const now = Date.now();

    const invitation = await resolveInvitationForCaller(ctx, args.token, userId, now);
    await ctx.db.patch(invitation._id, { status: "declined", respondedAt: now });
    // Saying no to the offer says no to the credential as well. This writes no
    // audit event for the same reason the decline itself does not — see above.
    await invalidateInvitationSignInCode(ctx, invitation);
    return null;
  },
});

/**
 * Sweep answered and abandoned invitations.
 *
 * Housekeeping only: expiry is enforced on every read and every write, so this
 * changes no decision. Without it the table grows by a row for every person
 * anybody ever tried to invite, forever.
 *
 * Bounded batch, so a backlog drains over several runs rather than in one
 * transaction big enough to hit a limit.
 */
export const purgeExpiredInvitations = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), moreRemaining: v.boolean() }),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? SWEEP_BATCH_SIZE, 1), 1000);
    const cutoff = Date.now() - INVITATION_RETENTION_MS;

    const expired = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", cutoff))
      .take(limit);

    for (const row of expired) {
      await ctx.db.delete(row._id);
    }

    return { deleted: expired.length, moreRemaining: expired.length === limit };
  },
});
