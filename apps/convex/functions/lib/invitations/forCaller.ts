/**
 * Whether an invitation token is one this caller may answer right now.
 *
 * Split out of `functions/invitations.ts` so the report and block paths
 * (`lib/blocks.ts`) resolve an invitation through the same predicate
 * `acceptInvitation` does, rather than a second copy of it. This module
 * registers nothing.
 */

import type { QueryCtx } from "../../../_generated/server";
import type { Doc, Id } from "../../../_generated/dataModel";
import { resolveAddressedUser } from "../identities";
import { hasBlocked } from "../blocks";

/** Whether an invitation is answerable right now. */
export function isPending(invitation: Doc<"workspaceInvitations">, now: number): boolean {
  return invitation.status === "pending" && invitation.expiresAt > now;
}

/**
 * The invitation this token addresses to `userId`, or `null` for every other
 * case — never issued, answered, expired, addressed to somebody else, or sent
 * by somebody this caller has blocked. One answer for all of them; see
 * `resolveInvitationForCaller` in `functions/invitations.ts` for why, and for
 * the one timing asymmetry that is deliberately left alone.
 *
 * The block is checked last, after the addressee: it is a fact about this
 * caller's own choices, so it is only ever consulted for an invitation that
 * really is theirs.
 */
export async function invitationForCaller(
  ctx: QueryCtx,
  token: string,
  userId: Id<"users">,
  now: number,
): Promise<Doc<"workspaceInvitations"> | null> {
  const invitation = await ctx.db
    .query("workspaceInvitations")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (invitation === null) return null;
  if (!isPending(invitation, now)) return null;

  const addressed = await resolveAddressedUser(ctx, {
    kind: invitation.inviteeKind,
    value: invitation.invitee,
  });
  if (addressed === null || addressed !== userId) return null;

  if (await hasBlocked(ctx, userId, invitation.invitedBy)) return null;

  return invitation;
}
