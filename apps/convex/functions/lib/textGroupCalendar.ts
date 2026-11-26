/**
 * A Google calendar shared with one Tex group chat (decided by the owner, 2026-11-19: a group check-in compares a
 * member's calendar with what the chat said; the calendar's own person opts in). Mirror of `textGroupMail.ts`, without
 * the Gmail search.
 *
 * A group chat's turn reads no one's calendar: a Google calendar is connected to its person's personal workspace, and
 * the chat has no grant on it. So the calendar's own person shares it with the chat, by their own words in it ("Tex,
 * share my calendar here"), and the chat's check-in can then compare what the calendar says with what the chat said:
 *
 * - Only the account that owns the calendar can share it, and only into a chat it is one of the people of (`inChat`,
 *   reused from `textGroupMail.ts`). The share belongs to the chat, not to a workspace, as mail does.
 * - It is read live, by any call on that chat's own grant, while the chat is not muted and the sharer is still one of
 *   its people with that calendar connected. Asked at every read, never cached; nothing of an event is kept.
 * - Only the sharer stops it ("Tex, stop sharing my calendar here"), or anything that ends the chat's reach to them:
 *   muting, leaving the chat, disconnecting the calendar.
 * - A chat's grant reads a calendar shared into a different chat never: a share is matched by its chat's key.
 *
 * Reading stays in `functions/personCalendar.ts` (`chatCalendarRead`), which applies the same reconnect, AI-access and
 * rate-limit rules as the owner's own read.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordAudit } from "./audit";
import { contextsForGrant, resolveLiveGrant } from "./controlPlane/liveGrants";
import { personalWorkspaceOf } from "./faces/people";
import { speaksUpOf } from "./texChatRules";
import { inChat } from "./textGroupMail";

/** The client every group grant is minted for; the audit names it beside the person. */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
/** Most calendars one chat reads. */
const MAX_SHARES = 10;

/**
 * A calendar a chat's turn may read now, with the connection it reads through: one shared into the chat, or, on a turn
 * its own person asked for, one of theirs (`own`).
 */
export type LiveCalendarShare = { share: { userId: Id<"users">; address: string }; connection: Doc<"googleConnections">; own?: true };

/** The person's own live calendar connection at this address, or null. */
async function ownCalendar(ctx: QueryCtx, userId: Id<"users">, address: string): Promise<Doc<"googleConnections"> | null> {
  const personal = await personalWorkspaceOf(ctx, userId);
  // Their own personal workspace, as `personalOwnerReadClearance` asks: never one they were only given.
  if (personal === null || personal.createdBy !== userId) return null;
  const rows = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", personal._id))
    .take(20);
  return (
    rows.find(
      (row) =>
        row.disconnectedAt === undefined &&
        row.products.includes("calendar") &&
        row.address.toLowerCase() === address,
    ) ?? null
  );
}

/** Every calendar the person has connected, live, on their own personal workspace. */
async function ownCalendars(ctx: QueryCtx, userId: Id<"users">): Promise<Doc<"googleConnections">[]> {
  const personal = await personalWorkspaceOf(ctx, userId);
  if (personal === null || personal.createdBy !== userId) return [];
  const rows = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", personal._id))
    .take(20);
  return rows.filter((row) => row.disconnectedAt === undefined && row.products.includes("calendar"));
}

/**
 * "Tex, share my calendar here": the addresses shared, or null when none may be (not theirs, not connected, not one of
 * the chat's people, the chat muted, or the chat already holds its ten). With no address, every calendar they have
 * connected is shared, one row each. The share and its audit sit on the sharer's personal workspace.
 */
export async function shareCalendar(
  ctx: MutationCtx,
  group: Doc<"textGroups">,
  userId: Id<"users">,
  address: string | undefined,
  now: number,
): Promise<{ addresses: string[] } | null> {
  if (!(await inChat(ctx, group, userId))) return null;
  const workspace = await personalWorkspaceOf(ctx, userId);
  if (workspace === null) return null;
  const calendars = address === undefined ? await ownCalendars(ctx, userId) : [await ownCalendar(ctx, userId, address)];
  const owned = calendars.filter((row): row is Doc<"googleConnections"> => row !== null);
  if (owned.length === 0) return null;
  const addresses = owned.map((row) => row.address.toLowerCase());
  const rows = await ctx.db
    .query("chatCalendarShares")
    .withIndex("by_group", (q) => q.eq("groupKey", group.groupKey))
    .take(MAX_SHARES * 4);
  const fresh = addresses.filter((value) => !rows.some((row) => row.userId === userId && row.address === value));
  if (rows.length + fresh.length > MAX_SHARES) return null;
  for (const value of addresses) {
    const existing = rows.find((row) => row.userId === userId && row.address === value);
    if (existing !== undefined) {
      await ctx.db.patch(existing._id, { workspaceId: workspace._id, createdAt: now });
    } else {
      await ctx.db.insert("chatCalendarShares", { groupKey: group.groupKey, workspaceId: workspace._id, userId, address: value, createdAt: now });
    }
    await recordAudit(ctx, {
      workspaceId: workspace._id,
      actorUserId: userId,
      actorClientId: TEXTS_GROUP_CLIENT_ID,
      action: "calendar.shared_with_chat",
      details: {},
    });
  }
  return { addresses };
}

/** "Tex, stop sharing my calendar here": how many of the sender's calendar shares in this chat ended. */
export async function unshareCalendar(
  ctx: MutationCtx,
  group: Doc<"textGroups">,
  userId: Id<"users">,
  address: string | undefined,
): Promise<number> {
  const rows = await ctx.db
    .query("chatCalendarShares")
    .withIndex("by_group", (q) => q.eq("groupKey", group.groupKey))
    .take(MAX_SHARES * 4);
  const ended = rows.filter((row) => row.userId === userId && (address === undefined || row.address === address));
  for (const row of ended) {
    await ctx.db.delete(row._id);
    await recordAudit(ctx, {
      workspaceId: row.workspaceId,
      actorUserId: userId,
      actorClientId: TEXTS_GROUP_CLIENT_ID,
      action: "calendar.unshared_from_chat",
      details: {},
    });
  }
  return ended.length;
}

/**
 * The calendars this chat's turns may read now: shared into it by somebody still one of its people, through a calendar
 * they still have connected. Asked at every read, never cached.
 */
export async function liveCalendarShares(ctx: QueryCtx, group: Doc<"textGroups">): Promise<LiveCalendarShare[]> {
  if (speaksUpOf(group) === "off") return [];
  const rows = await ctx.db
    .query("chatCalendarShares")
    .withIndex("by_group", (q) => q.eq("groupKey", group.groupKey))
    .take(MAX_SHARES);
  const live: LiveCalendarShare[] = [];
  for (const share of rows) {
    if (!(await inChat(ctx, group, share.userId))) continue;
    const connection = await ownCalendar(ctx, share.userId, share.address);
    if (connection !== null) live.push({ share: { userId: share.userId, address: share.address }, connection });
  }
  return live;
}

/**
 * The asker's own calendars, on a turn they asked for (Dev2, 2026-11-26: "Tex what was my meeting today about" in a
 * group went the long way round, through their own 1:1 Tex, because a group turn read no one's calendar). Read on the
 * asker's own grant only (`reachFor: "asker"`, held by them, no guest acting through it), while they are one of the
 * chat's people; a turn nobody asked for, a guest's ask and anyone else's tag read none of them. What gets said from it
 * in front of the room is Training's, as for the asker's shared workspaces (`docs/decisions/texting-assistant/asker-reach.md`).
 */
async function askerCalendars(ctx: QueryCtx, group: Doc<"textGroups">, asker: Id<"users">): Promise<LiveCalendarShare[]> {
  if (speaksUpOf(group) === "off") return [];
  if (!(await inChat(ctx, group, asker))) return [];
  return (await ownCalendars(ctx, asker)).map((connection) => ({
    share: { userId: asker, address: connection.address.toLowerCase() },
    connection,
    own: true as const,
  }));
}

/** Whose calendar this grant reads as its asker's own: the asker's id, or null for any other grant. */
function askerOf(grant: { userId: Id<"users">; texGroup?: Doc<"oauthGrants">["texGroup"] }): Id<"users"> | null {
  const chat = grant.texGroup;
  if (chat === undefined || chat.reachFor !== "asker") return null;
  // Held by the asker themselves: a guest's ask stands on the sponsor's grant, and so does an invited person's.
  if (chat.taggerId === undefined || chat.taggerId !== grant.userId) return null;
  if (chat.guestPhone !== undefined || chat.guestTagger === true || chat.invitedTaggerRole !== undefined) return null;
  return grant.userId;
}

/** Shares and the asker's own calendars together, one row per address, the share first. */
function withOwn(shares: LiveCalendarShare[], own: LiveCalendarShare[]): LiveCalendarShare[] {
  return [...shares, ...own.filter((row) => !shares.some(({ share }) => share.userId === row.share.userId && share.address === row.share.address))];
}

/** Who shares which calendar here, by handle, for the chat's turn to be told: `{ calendar }` on a turn's answer, or `{}`. */
export async function calendarSharesNamed(
  ctx: QueryCtx,
  groupId: Id<"textGroups">,
  asker: Id<"users"> | null = null,
): Promise<{ calendar?: { handle: string; address: string }[] }> {
  const group = await ctx.db.get(groupId);
  const shares = group === null ? [] : await liveCalendarShares(ctx, group);
  const rows = group === null || asker === null ? shares : withOwn(shares, await askerCalendars(ctx, group, asker));
  const named: { handle: string; address: string }[] = [];
  for (const { share } of rows) {
    const personal = await personalWorkspaceOf(ctx, share.userId);
    if (personal !== null) named.push({ handle: personal.slug, address: share.address });
  }
  return named.length > 0 ? { calendar: named } : {};
}

/**
 * The shared calendars a group chat's grant may read now, or null when this is no chat's grant. Any workspace the grant
 * covers asks for the same calendars: the share is the chat's, so the call's workspace never decides it (as
 * `chatMailClearance` does).
 */
export async function chatCalendarClearance(
  ctx: QueryCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string },
): Promise<LiveCalendarShare[] | null> {
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  const chat = live?.grant.texGroup;
  if (live === null || chat === undefined) return null;
  // The workspace asked about is one of the grant's own rows (its reach or its home), never a name the caller supplies
  // that the grant does not cover.
  const covered = (await contextsForGrant(ctx, live)).some((row) => String(row.workspaceId) === args.expectedWorkspaceId);
  if (!covered && String(live.grant.workspaceId) !== args.expectedWorkspaceId) return null;
  const group = await ctx.db.get(chat.groupId);
  if (group === null) return null;
  const shares = await liveCalendarShares(ctx, group);
  const asker = askerOf(live.grant);
  return asker === null ? shares : withOwn(shares, await askerCalendars(ctx, group, asker));
}
