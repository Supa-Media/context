/**
 * Joining a workspace on an invitation: the one place `workspaceMembers` gets
 * a row from one. `acceptInvitation` (the invitee's own click) and a phone
 * invitation's acceptance at the invitee's first sign-in with that number
 * (`acceptPhoneInvitations`) both go through here, so the spend, the group
 * names and the audit cannot differ between them.
 */

import type { MutationCtx } from "../../../_generated/server";
import type { Doc, Id } from "../../../_generated/dataModel";
import { invalidateInvitationSignInCode } from "../../invitationEmail";
import { recordAudit } from "../audit";
import { hasBlocked } from "../blocks";
import { clearGroupNames } from "../workspaces/groupNames";
import { getMembership } from "../workspaceAuth";
import { isPending } from "./forCaller";
import { isReservedReviewer } from "../reviewerAccount";

/** The most phone invitations one sign-in accepts; nobody is invited to this many workspaces by one number. */
const MAX_PHONE_INVITATIONS = 50;

/**
 * Spend `invitation` and make `userId` a member at its role, unless they are
 * one already. The caller has decided `userId` is who it was addressed to.
 */
export async function joinByInvitation(
  ctx: MutationCtx,
  invitation: Doc<"workspaceInvitations">,
  userId: Id<"users">,
  now: number,
  details: Record<string, string> = {},
): Promise<{ workspace: Doc<"workspaces">; role: string } | null> {
  const workspace = await ctx.db.get(invitation.workspaceId);
  if (workspace === null) return null;
  // The reserved reviewer joins nobody's workspace (`reviewerAccount.ts`); the
  // invitation stays unspent, the same answer as one that is not there.
  if (await isReservedReviewer(ctx, userId)) return null;

  // Spend it first. Everything after this is idempotent, so a retry that
  // races itself joins once.
  await ctx.db.patch(invitation._id, { status: "accepted", respondedAt: now });
  // The link has been answered, by somebody who is signed in as we speak, so
  // the code it carried has no remaining job. Leaving it would be a standing
  // credential in a mail archive outliving the thing it was minted for.
  await invalidateInvitationSignInCode(ctx, invitation);

  const existing = await getMembership(ctx, workspace._id, userId);
  if (existing !== null) return { workspace, role: existing.role };

  // `resolveGroupMembers` and `grantedNamesFor` intersect a group row with live
  // membership, so every group name this person was left in when they were
  // removed comes back the moment the row below lands. Rejoining starts from
  // no names; the owner names them again if that is what they meant. Ahead
  // of the insert for readability only — one mutation is one transaction, so
  // nothing observes the order. See `lib/workspaces/groupNames.ts`.
  await clearGroupNames(ctx, workspace._id, userId);

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
    details: { role: invitation.role, invitedBy: invitation.invitedBy, ...details },
  });

  return { workspace, role: invitation.role };
}

/**
 * Every pending invitation to `phone`, accepted for `userId`, who has just
 * proved they hold it (a texted code, or a code to that number). The owner
 * invited that number from a chat its holder was in, and the decision is that
 * proving the number is the answer (the owner, 2026-10-27;
 * `docs/decisions/texting-assistant/invited-family.md`). Never one from
 * somebody this person blocked.
 */
export async function acceptPhoneInvitations(ctx: MutationCtx, userId: Id<"users">, phone: string): Promise<number> {
  const now = Date.now();
  const rows = await ctx.db
    .query("workspaceInvitations")
    .withIndex("by_invitee", (q) => q.eq("inviteeKind", "phone").eq("invitee", phone))
    .take(MAX_PHONE_INVITATIONS);
  let joined = 0;
  for (const invitation of rows) {
    if (!isPending(invitation, now)) continue;
    if (await hasBlocked(ctx, userId, invitation.invitedBy)) continue;
    if ((await joinByInvitation(ctx, invitation, userId, now, { via: "phone" })) !== null) joined += 1;
  }
  return joined;
}
