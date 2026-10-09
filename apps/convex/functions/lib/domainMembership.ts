import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordAudit } from "./audit";
import { domainOf } from "./emailDomains";
import { deleteMemberPlaces } from "./places";
import { confirmedEmailsOf } from "./signInEmails";

/**
 * Membership through an email domain (`functions/workspaceDomains.ts`): which
 * domains a person signs in with, and leaving when they no longer do.
 */

/** The domains this person signs in with, each once. */
export async function myDomains(ctx: QueryCtx, userId: Id<"users">): Promise<Map<string, string>> {
  const byDomain = new Map<string, string>();
  for (const email of await confirmedEmailsOf(ctx, userId)) {
    const domain = domainOf(email);
    if (domain !== null && !byDomain.has(domain)) byDomain.set(domain, email);
  }
  return byDomain;
}

/**
 * After an address goes from an account: leave every workspace joined through
 * a domain this person no longer signs in with. Called by `removeEmail`.
 */
export async function leaveDroppedDomains(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const still = await myDomains(ctx, userId);
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(500);
  for (const membership of memberships) {
    if (membership.viaDomain === undefined || still.has(membership.viaDomain)) continue;
    if (membership.role === "owner") continue;
    await ctx.db.delete(membership._id);
    await deleteMemberPlaces(ctx, membership.workspaceId, userId);
    await recordAudit(ctx, {
      workspaceId: membership.workspaceId,
      actorUserId: userId,
      action: "member.left",
      details: { viaDomain: membership.viaDomain, reason: "email_removed" },
    });
  }
}
