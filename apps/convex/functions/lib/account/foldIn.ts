import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { MAX_EMAILS_PER_ACCOUNT } from "../signInEmails";
import { deletePersonalRows } from "./personalRows";

/**
 * Option C (Dev2, 2026-10-09): accounts are never joined, but an account that
 * owns nothing can be folded into another. Two ways in: adding its address on
 * Account settings (`functions/signInEmails.ts`), and answering "yes" to "Do
 * you already use Context with another email?" at a first sign-in
 * (`functions/otherEmail.ts`).
 */

/** Whether `userId` owns any workspace, personal or shared. */
export async function ownsAnything(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(200);
  return memberships.some((membership) => membership.role === "owner");
}

/**
 * Fold an account that owns nothing into `intoId`: its memberships move (the
 * stronger role wins where both are members), then it closes. Its address
 * is cleared before the close so the close does not revoke what was shared
 * with it — that address now belongs to `intoId`.
 */
export async function foldIn(ctx: MutationCtx, fromId: Id<"users">, intoId: Id<"users">): Promise<void> {
  const rank: Record<Doc<"workspaceMembers">["role"], number> = { member: 0, editor: 1, owner: 2 };
  const moving = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", fromId))
    .take(200);
  for (const membership of moving) {
    const existing = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", intoId))
      .filter((q) => q.eq(q.field("workspaceId"), membership.workspaceId))
      .first();
    if (existing === null) {
      await ctx.db.patch(membership._id, { userId: intoId });
    } else {
      if (rank[membership.role] > rank[existing.role]) await ctx.db.patch(existing._id, { role: membership.role });
      await ctx.db.delete(membership._id);
    }
    await recordAudit(ctx, {
      workspaceId: membership.workspaceId,
      actorUserId: intoId,
      action: "member.merged_sign_in_email",
    });
  }
  // Every address on the closing account moves with it, so nothing shared
  // with any of them is revoked by the close below.
  const attached = await ctx.db
    .query("signInEmails")
    .withIndex("by_user", (q) => q.eq("userId", fromId))
    .take(MAX_EMAILS_PER_ACCOUNT + 1);
  for (const row of attached) await ctx.db.patch(row._id, { userId: intoId });
  const from = await ctx.db.get(fromId);
  const fromEmail = from?.email?.toLowerCase();
  if (fromEmail !== undefined && from?.emailVerificationTime !== undefined) {
    await ctx.db.insert("signInEmails", { userId: intoId, email: fromEmail, addedAt: Date.now() });
  }
  await ctx.db.patch(fromId, { email: undefined });
  await deletePersonalRows(ctx, fromId);
}
