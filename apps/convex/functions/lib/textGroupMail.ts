/**
 * A mailbox shared with one Tex group chat (decided by the owner, 2026-10-27;
 * `docs/decisions/texting-assistant/chat-mail.md`).
 *
 * The owner's family business runs on a work Gmail that Google Groups fan
 * into, and the family wants Tex in their chat to see that mail, triage it
 * and draft replies. A Google account is connected to its person's personal
 * workspace, and a group turn reads no one's mail. So the mailbox's own
 * person shares it with the chat, by their own words in it ("Tex, share my
 * mail from me@work.example here"), optionally narrowed by a Gmail search:
 *
 * - Only the account that owns the mailbox can share it, and only into a
 *   chat it is one of the people of (`textGroups.homeUsers`, the accounts the
 *   chat's sealed home names). A chat is bound to no workspace (the owner,
 *   2026-10-31 and 2026-11-11: every chat has its own home, and reaches
 *   whatever all its people share), so the share belongs to the chat, not to a
 *   workspace. A guest chat too (Dev2, 2026-10-29: "it should work even in
 *   guest mode if I'm sharing my email explicitly"): the sharer chose to show
 *   it to whoever is in that chat. A guest chat reads it when asked; its looks
 *   stay off.
 * - It is read live, by any call on that chat's own grant (its home, or a
 *   workspace it reaches), while the chat is not muted and the sharer is still
 *   one of its people with that Gmail connected; every read is narrowed by the
 *   share's search. Nothing of a message is kept.
 * - Only the sharer stops it ("Tex, stop sharing my mail here"), or anything
 *   that ends the chat's reach to them: muting, leaving the chat,
 *   disconnecting the Gmail.
 * - A chat from before homes (`homeUsers` unset: bound to one workspace, as a
 *   deployment with no pinned workspace still runs) keeps the old rule: its
 *   people are those who still write in the workspace it is bound to.
 *
 * Sending stays the sharer's own yes: a group turn sends from someone's own
 * Gmail only on their 👍 (`apps/mcp/src/agent/groupTurn.js`).
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordAudit } from "./audit";
import { contextsForGrant, resolveLiveGrant } from "./controlPlane/liveGrants";
import { chatWorkspace } from "./textGroupReach";
import { writingRole } from "./routines/access";
import { personalWorkspaceOf } from "./faces/people";
import { speaksUpOf } from "./texChatRules";

/** The client every group grant is minted for; the audit names it beside the person. */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
/** The longest search a share may be narrowed by. */
export const MAX_SHARE_QUERY = 300;
/** Most mailboxes one chat reads. */
const MAX_SHARES = 10;
const ADDRESS = /^[^\s@/]{1,64}@[^\s@/]{1,190}$/;

/** A share a chat's turn may read now, with the connection it reads through. */
export type LiveMailShare = { share: Doc<"chatMailShares">; connection: Doc<"googleConnections"> };

export function cleanAddress(value: string): string | null {
  const address = value.trim().toLowerCase();
  return ADDRESS.test(address) ? address : null;
}

export function cleanShareQuery(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  const query = value.trim();
  if (query === "") return undefined;
  return query.length > MAX_SHARE_QUERY ? null : query;
}

/** The person's own live Gmail connection at this address, or null. */
async function ownGmail(ctx: QueryCtx, userId: Id<"users">, address: string): Promise<Doc<"googleConnections"> | null> {
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
        row.products.includes("gmail") &&
        row.gmail !== undefined &&
        row.address.toLowerCase() === address,
    ) ?? null
  );
}

/**
 * Whether `userId` is one of the chat's people, for sharing their mail into it or for it to go on reading: named by
 * its home (`homeUsers`), or, for a chat from before homes, still a writer in the workspace it was bound to.
 */
async function inChat(ctx: QueryCtx, group: Doc<"textGroups">, userId: Id<"users">): Promise<boolean> {
  if (speaksUpOf(group) === "off") return false;
  if (group.homeUsers !== undefined) return group.homeUsers.includes(userId);
  const workspace = await chatWorkspace(ctx, group);
  if (workspace === null || workspace.kind !== "shared") return false;
  return (await writingRole(ctx, workspace._id, userId)) !== null;
}

/**
 * "Tex, share my mail from <address> here": the address, or null when it may
 * not be (not theirs, not connected, not one of the chat's people, the chat
 * muted): one answer for all of them. The share and its audit sit on the
 * sharer's own personal workspace, where the mailbox is connected.
 */
export async function shareMail(
  ctx: MutationCtx,
  group: Doc<"textGroups">,
  userId: Id<"users">,
  address: string,
  query: string | undefined,
  now: number,
): Promise<{ address: string; narrowed: boolean } | null> {
  if (!(await inChat(ctx, group, userId))) return null;
  const workspace = await personalWorkspaceOf(ctx, userId);
  if (workspace === null || (await ownGmail(ctx, userId, address)) === null) return null;
  const rows = await ctx.db
    .query("chatMailShares")
    .withIndex("by_group", (q) => q.eq("groupKey", group.groupKey))
    .take(MAX_SHARES * 4);
  const existing = rows.find((row) => row.userId === userId && row.address === address);
  if (existing === undefined && rows.length >= MAX_SHARES) return null;
  if (existing === undefined) {
    await ctx.db.insert("chatMailShares", {
      groupKey: group.groupKey,
      workspaceId: workspace._id,
      userId,
      address,
      ...(query !== undefined ? { query } : {}),
      createdAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, { workspaceId: workspace._id, query, createdAt: now });
  }
  await recordAudit(ctx, {
    workspaceId: workspace._id,
    actorUserId: userId,
    actorClientId: TEXTS_GROUP_CLIENT_ID,
    action: "mail.shared_with_chat",
    details: { narrowed: query !== undefined },
  });
  return { address, narrowed: query !== undefined };
}

/** "Tex, stop sharing my mail here": how many of the sender's shares in this chat ended. */
export async function unshareMail(ctx: MutationCtx, group: Doc<"textGroups">, userId: Id<"users">, address: string | undefined): Promise<number> {
  const rows = await ctx.db
    .query("chatMailShares")
    .withIndex("by_group", (q) => q.eq("groupKey", group.groupKey))
    .take(MAX_SHARES * 4);
  const ended = rows.filter((row) => row.userId === userId && (address === undefined || row.address === address));
  for (const row of ended) {
    await ctx.db.delete(row._id);
    await recordAudit(ctx, {
      workspaceId: row.workspaceId,
      actorUserId: userId,
      actorClientId: TEXTS_GROUP_CLIENT_ID,
      action: "mail.unshared_from_chat",
      details: {},
    });
  }
  return ended.length;
}

/**
 * The mailboxes this chat's turns may read now: shared into it by somebody who
 * is still one of its people, through a Gmail they still have connected.
 * Asked at every read, never cached.
 */
export async function liveMailShares(ctx: QueryCtx, group: Doc<"textGroups">): Promise<LiveMailShare[]> {
  if (speaksUpOf(group) === "off") return [];
  const rows = await ctx.db
    .query("chatMailShares")
    .withIndex("by_group", (q) => q.eq("groupKey", group.groupKey))
    .take(MAX_SHARES);
  const live: LiveMailShare[] = [];
  for (const share of rows) {
    if (!(await inChat(ctx, group, share.userId))) continue;
    const connection = await ownGmail(ctx, share.userId, share.address);
    if (connection !== null) live.push({ share, connection });
  }
  return live;
}

/** Who shares which mailbox here, by handle, for the chat's turn to be told: `{ mail }` on a turn's answer, or `{}`. */
export async function mailSharesNamed(ctx: QueryCtx, groupId: Id<"textGroups">): Promise<{ mail?: { handle: string; address: string }[] }> {
  const group = await ctx.db.get(groupId);
  const named: { handle: string; address: string }[] = [];
  for (const { share } of group === null ? [] : await liveMailShares(ctx, group)) {
    const personal = await personalWorkspaceOf(ctx, share.userId);
    if (personal !== null) named.push({ handle: personal.slug, address: share.address });
  }
  return named.length > 0 ? { mail: named } : {};
}

/**
 * The shared mailboxes a group chat's grant may read now, for a live read of
 * the person's mail (`functions/personMail.ts`), or null when this is no chat's
 * grant. Any workspace the grant itself covers (its home in the pin, or one
 * the chat reaches) asks for the same mail: the share is the chat's, so the
 * call's workspace never decides it (2026-11-11: a chat's default calls go to
 * its home, and every one of them was refused while this asked for the one
 * workspace `chatWorkspace` picked).
 */
export async function chatMailClearance(
  ctx: QueryCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string },
): Promise<LiveMailShare[] | null> {
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  const chat = live?.grant.texGroup;
  if (live === null || chat === undefined) return null;
  // The workspace asked about is one of the grant's own rows (its reach or its home), never a name the caller supplies
  // that the grant does not cover.
  const covered = (await contextsForGrant(ctx, live)).some((row) => String(row.workspaceId) === args.expectedWorkspaceId);
  if (!covered && String(live.grant.workspaceId) !== args.expectedWorkspaceId) return null;
  const group = await ctx.db.get(chat.groupId);
  if (group === null) return null;
  return await liveMailShares(ctx, group);
}

/** The workspaces, by slug, that the group chats a person's own mailbox is shared with now reach. */
export async function chatsWatching(ctx: QueryCtx, userId: Id<"users">, address: string): Promise<string[]> {
  const shares = (await ctx.db.query("chatMailShares").withIndex("by_user", (q) => q.eq("userId", userId)).take(50)).filter(
    (share) => share.address === address,
  );
  const slugs = new Set<string>();
  for (const share of shares) {
    const group = (await ctx.db.query("textGroups").withIndex("by_key", (q) => q.eq("groupKey", share.groupKey)).first()) ?? null;
    // A guest chat reads it only when asked, never on its own, so it watches nothing for the person's check-in.
    if (group === null || speaksUpOf(group) === "off" || group.guestGroupId !== undefined) continue;
    if (!(await inChat(ctx, group, userId))) continue;
    // Named by the workspace the chat reaches, the way the person knows it; a chat that reaches none has no handle yet.
    const workspace = await chatWorkspace(ctx, group);
    if (workspace !== null) slugs.add(workspace.slug);
  }
  return [...slugs];
}
