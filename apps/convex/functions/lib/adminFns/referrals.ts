/**
 * The staff console's "Invited by friends" tab and community links.
 *
 * Handlers only. Each exported function in `functions/admin.ts` authorizes
 * with `requireAdmin` inline before calling one of these — see that file's
 * header and `__tests__/adminSurface.test.ts`.
 */

import { ConvexError, v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { AdminActor } from "../admin";
import { handleForUser } from "../identities";
import {
  allowanceFor,
  communityUrl,
  invitesOff,
  invitesTo,
  MAX_COMMUNITY_LINKS,
  MAX_LINK_LABEL,
  sentBy,
  type InviteStatus,
} from "../referrals";
import { recordAdminAudit } from "./audit";

/** Invites one listing reads, newest first. */
export const REFERRAL_PAGE = 300;
/** The most invites staff may give one person in one press. */
export const MAX_GRANT = 50;

export const inviteStatusValidator = v.union(
  v.literal("pending"),
  v.literal("joined"),
  v.literal("expired"),
  v.literal("cancelled"),
  v.literal("revoked"),
);

export const referralRowValidator = v.object({
  id: v.id("referralInvites"),
  email: v.string(),
  inviterUserId: v.id("users"),
  inviterHandle: v.union(v.null(), v.string()),
  inviterUsed: v.number(),
  inviterTotal: v.number(),
  sentAt: v.number(),
  expiresAt: v.number(),
  status: inviteStatusValidator,
  joinedHandle: v.union(v.null(), v.string()),
});

export async function listReferralsHandler(ctx: QueryCtx) {
  const now = Date.now();
  const rows = await ctx.db
    .query("referralInvites")
    .withIndex("by_createdAt")
    .order("desc")
    .take(REFERRAL_PAGE + 1);
  const counts: Record<InviteStatus, number> = { pending: 0, joined: 0, expired: 0, cancelled: 0, revoked: 0 };
  const inviters = new Map<Id<"users">, { handle: string | null; used: number; total: number }>();
  const out = [];
  for (const invite of rows.slice(0, REFERRAL_PAGE)) {
    const { statuses, account } = await invitesTo(ctx.db, invite.email, now);
    const status = statuses.get(invite._id) ?? "expired";
    counts[status] += 1;
    let inviter = inviters.get(invite.inviterUserId);
    if (inviter === undefined) {
      const allowance = await allowanceFor(ctx.db, invite.inviterUserId, now);
      inviter = {
        handle: await handleForUser(ctx, invite.inviterUserId),
        used: allowance.used,
        total: allowance.total,
      };
      inviters.set(invite.inviterUserId, inviter);
    }
    out.push({
      id: invite._id,
      email: invite.email,
      inviterUserId: invite.inviterUserId,
      inviterHandle: inviter.handle,
      inviterUsed: inviter.used,
      inviterTotal: inviter.total,
      sentAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      status,
      joinedHandle: status === "joined" && account !== null ? await handleForUser(ctx, account._id) : null,
    });
  }
  return { rows: out, more: rows.length > REFERRAL_PAGE, counts, invitesOff: await invitesOff(ctx.db) };
}

/**
 * One invite's story: who sent it, when it was used and by whom, and who that
 * person went on to invite.
 */
export async function traceReferralHandler(ctx: QueryCtx, inviteId: Id<"referralInvites">) {
  const invite = await ctx.db.get(inviteId);
  if (invite === null) return null;
  const now = Date.now();
  const { statuses, account } = await invitesTo(ctx.db, invite.email, now);
  const status = statuses.get(invite._id) ?? "expired";
  const joined = status === "joined" && account !== null ? account : null;
  const onward = joined === null ? [] : await sentBy(ctx.db, joined._id, now);
  return {
    email: invite.email,
    status,
    inviterHandle: await handleForUser(ctx, invite.inviterUserId),
    sentAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    cancelledAt: invite.cancelledAt ?? null,
    revokedAt: invite.revokedAt ?? null,
    joinedAt: joined?._creationTime ?? null,
    joinedHandle: joined === null ? null : await handleForUser(ctx, joined._id),
    onward: onward.map((row) => ({ email: row.invite.email, status: row.status, sentAt: row.invite.createdAt })),
  };
}

/** Stop an unused invite. It stays used; nobody is mailed. */
export async function revokeReferralHandler(ctx: MutationCtx, inviteId: Id<"referralInvites">, actor: AdminActor) {
  const invite = await ctx.db.get(inviteId);
  if (invite === null) return { changed: false };
  const { statuses } = await invitesTo(ctx.db, invite.email, Date.now());
  if (statuses.get(invite._id) !== "pending") return { changed: false };
  await ctx.db.patch(invite._id, { status: "revoked", revokedAt: Date.now(), revokedBy: actor.userId });
  await recordAdminAudit(ctx, actor, "referral.revoked", invite._id);
  return { changed: true };
}

/** Give one person more invites. They are not mailed; their count goes up. */
export async function grantInvitesHandler(ctx: MutationCtx, userId: Id<"users">, add: number, actor: AdminActor) {
  if (!Number.isInteger(add) || add < 1 || add > MAX_GRANT) {
    throw new ConvexError({ code: "INVALID_ARGUMENT", message: `Give between 1 and ${MAX_GRANT}.` });
  }
  if ((await ctx.db.get(userId)) === null) throw new ConvexError({ code: "NOT_FOUND", message: "No such person." });
  const row = await ctx.db
    .query("referralAllowances")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const extra = (row?.extra ?? 0) + add;
  if (row === null) await ctx.db.insert("referralAllowances", { userId, extra, updatedAt: Date.now() });
  else await ctx.db.patch(row._id, { extra, updatedAt: Date.now() });
  await recordAdminAudit(ctx, actor, "referral.granted", userId, { add });
  return { extra };
}

/** Pause or resume new invites. Live ones keep working. */
export async function setInvitesOffHandler(ctx: MutationCtx, off: boolean, actor: AdminActor) {
  const row = await ctx.db.query("referralSettings").first();
  const patch = { invitesOff: off, updatedAt: Date.now(), updatedBy: actor.userId };
  if (row === null) await ctx.db.insert("referralSettings", patch);
  else await ctx.db.patch(row._id, patch);
  await recordAdminAudit(ctx, actor, "referral.switched", off ? "off" : "on");
  return { invitesOff: off };
}

export const communityKindValidator = v.union(
  v.literal("discord"),
  v.literal("github"),
  v.literal("x"),
  v.literal("newsletter"),
  v.literal("other"),
);

export const communityLinkValidator = v.object({
  id: v.id("communityLinks"),
  kind: communityKindValidator,
  label: v.string(),
  url: v.string(),
  audience: v.union(v.literal("members"), v.literal("everyone")),
  position: v.number(),
});

export async function listCommunityLinksHandler(ctx: QueryCtx) {
  const rows = await ctx.db.query("communityLinks").withIndex("by_position").take(MAX_COMMUNITY_LINKS);
  return rows.map((row) => ({
    id: row._id,
    kind: row.kind,
    label: row.label,
    url: row.url,
    audience: row.audience,
    position: row.position,
  }));
}

/** Add a link, or change one. Only https URLs are kept. */
export async function saveCommunityLinkHandler(
  ctx: MutationCtx,
  args: {
    id?: Id<"communityLinks">;
    kind: "discord" | "github" | "x" | "newsletter" | "other";
    label: string;
    url: string;
    audience: "members" | "everyone";
  },
  actor: AdminActor,
) {
  const url = communityUrl(args.url);
  if (url === null) throw new ConvexError({ code: "INVALID_URL", message: "Use a full https:// link." });
  const label = args.label.trim().slice(0, MAX_LINK_LABEL);
  if (label.length === 0) throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Give the link a name." });
  const now = Date.now();
  const fields = { kind: args.kind, label, url, audience: args.audience, updatedAt: now, updatedBy: actor.userId };
  let id = args.id;
  if (id !== undefined) {
    if ((await ctx.db.get(id)) === null) throw new ConvexError({ code: "NOT_FOUND", message: "That link is gone." });
    await ctx.db.patch(id, fields);
  } else {
    const existing = await ctx.db.query("communityLinks").withIndex("by_position").order("desc").take(MAX_COMMUNITY_LINKS);
    if (existing.length >= MAX_COMMUNITY_LINKS) {
      throw new ConvexError({ code: "LIMIT_REACHED", message: `At most ${MAX_COMMUNITY_LINKS} links.` });
    }
    id = await ctx.db.insert("communityLinks", { ...fields, position: (existing[0]?.position ?? 0) + 1 });
  }
  await recordAdminAudit(ctx, actor, "community.link_saved", id, { kind: args.kind, audience: args.audience });
  return { id };
}

export async function deleteCommunityLinkHandler(ctx: MutationCtx, id: Id<"communityLinks">, actor: AdminActor) {
  if ((await ctx.db.get(id)) === null) return { changed: false };
  await ctx.db.delete(id);
  await recordAdminAudit(ctx, actor, "community.link_deleted", id);
  return { changed: true };
}

