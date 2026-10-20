/**
 * Inviting somebody into a workspace, as whoever asked: the app's signed-in
 * owner (`inviteMember` in `functions/invitations.ts`) or the person behind an
 * agent's grant (`gatewayWorkspaces.invite`, so Tex can invite by text; the
 * owner, 2026-10-20). One handler, so the owner check, the string rules, the
 * rate limit, the pending cap and the no-oracle return cannot differ between
 * the two. The reasoning for every one of them is the module docstring of
 * `functions/invitations.ts`; read it before changing anything here.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { Doc, Id } from "../../../_generated/dataModel";
import { recordAudit } from "../audit";
import { randomOpaqueToken } from "../gatewayAuth";
import { resolveAddressedUser } from "../identities";
import { formatInvitee, inviteeRejectionError, parseInvitee, type Invitee } from "../invitees";
import { consumeRateLimit } from "../rateLimit";
import { isPending } from "./forCaller";
import { getMembership, requireWorkspaceRole } from "../workspaceAuth";

/**
 * How long an invitation stays answerable.
 *
 * A week: long enough to survive a holiday, short enough that a link forwarded
 * into a group chat two months ago is dead. Expiry is enforced on every read
 * and every write, never by the sweep — see `purgeExpiredInvitations`.
 */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
export const MAX_INVITATIONS_RETURNED = 200;
export const MAX_PENDING_INVITATIONS = 100;

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
export const INVITE_LIMIT = 20;
export const INVITE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The one row an invitation to this identifier would occupy, if any.
 *
 * `.unique()` is safe because every write goes through this lookup first, and
 * Convex mutations are serializable: a second insert for the same triple reads
 * the same index range, so the loser's transaction conflicts and re-runs. Same
 * argument `claimName` relies on for the global namespace.
 */
export async function findInvitationFor(
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

export type InviteRequest = {
  workspaceId: Id<"workspaces">;
  /** A `@name`, a bare name, or an email address. */
  invitee: string;
  /** Never `owner`: the callers' validators are the enforcement. */
  role: "editor" | "member";
};

/**
 * Invite `args.invitee` as `userId`, who must own the workspace. Returns
 * `null` in every case that is not a refusal about the string itself; see
 * `inviteMember`. `actorClientId` names the agent's client in the audit row
 * when an agent asked, because "who sent this invitation" otherwise has no
 * answer beyond the person.
 */
export async function inviteMemberHandler(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: InviteRequest,
  { actorClientId }: { actorClientId?: string } = {},
): Promise<null> {
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
    ...(actorClientId === undefined ? {} : { actorClientId }),
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
  // For a `@name` too. The scheduled job resolves the handle to its account's
  // verified address, which is safe *there* for the reason above and would
  // not be safe here; the inviter never learns whether it found one.
  await ctx.scheduler.runAfter(
    0,
    internal.functions.invitationEmail.sendInvitationEmail,
    { invitationId, inviteeKind: parsed.invitee.kind },
  );

  return null;
}
