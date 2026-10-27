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
 *   chat bound to a shared workspace where they are an owner or editor; never
 *   a guest chat, which reads only a corner of the workspace.
 * - It is read live, for one chat's turns, while the chat is bound to that
 *   workspace, not muted, and the sharer still writes there; every read is
 *   narrowed by the share's search. Nothing of a message is kept.
 * - Only the sharer stops it ("Tex, stop sharing my mail here"), or anything
 *   that ends the chat's reach: muting, rebinding, leaving the workspace,
 *   disconnecting the Gmail.
 *
 * Sending stays the sharer's own yes: a group turn sends from someone's own
 * Gmail only on their 👍 (`apps/mcp/src/agent/groupTurn.js`).
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordAudit } from "./audit";
import { resolveLiveGrant } from "./controlPlane/liveGrants";
import { writingRole } from "./routines/access";
import { personalWorkspaceOf } from "./faces/people";

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

/** The shared workspace this chat is bound to, when `userId` may share mail into it. */
async function sharingWorkspace(ctx: QueryCtx, group: Doc<"textGroups">, userId: Id<"users">): Promise<Doc<"workspaces"> | null> {
  if (group.workspaceId === undefined || group.guestGroupId !== undefined || group.mutedAt !== undefined) return null;
  const workspace = await ctx.db.get(group.workspaceId);
  if (workspace === null || workspace.kind !== "shared") return null;
  return (await writingRole(ctx, workspace._id, userId)) === null ? null : workspace;
}

/**
 * "Tex, share my mail from <address> here": the address, or null when it may
 * not be (not theirs, not connected, the chat not bound to a shared workspace
 * they write in): one answer for all of them.
 */
export async function shareMail(
  ctx: MutationCtx,
  group: Doc<"textGroups">,
  userId: Id<"users">,
  address: string,
  query: string | undefined,
  now: number,
): Promise<{ address: string; narrowed: boolean } | null> {
  const workspace = await sharingWorkspace(ctx, group, userId);
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
 * The mailboxes this chat's turns may read now: shared into it while it is
 * bound to the same workspace, by somebody who still writes there, through a
 * Gmail they still have connected. Asked at every read, never cached.
 */
export async function liveMailShares(ctx: QueryCtx, group: Doc<"textGroups">): Promise<LiveMailShare[]> {
  if (group.workspaceId === undefined || group.guestGroupId !== undefined || group.mutedAt !== undefined) return [];
  const rows = await ctx.db
    .query("chatMailShares")
    .withIndex("by_group", (q) => q.eq("groupKey", group.groupKey))
    .take(MAX_SHARES);
  const live: LiveMailShare[] = [];
  for (const share of rows) {
    if (share.workspaceId !== group.workspaceId) continue;
    if ((await writingRole(ctx, share.workspaceId, share.userId)) === null) continue;
    const connection = await ownGmail(ctx, share.userId, share.address);
    if (connection !== null) live.push({ share, connection });
  }
  return live;
}

/** Who shares which mailbox here, by handle, for the chat's turn to be told. */
export async function mailSharesNamed(ctx: QueryCtx, group: Doc<"textGroups">): Promise<{ handle: string; address: string }[]> {
  const named: { handle: string; address: string }[] = [];
  for (const { share } of await liveMailShares(ctx, group)) {
    const personal = await personalWorkspaceOf(ctx, share.userId);
    if (personal !== null) named.push({ handle: personal.slug, address: share.address });
  }
  return named;
}

/**
 * The shared mailboxes a group chat's grant may read now, for a live read of
 * the person's mail (`functions/personMail.ts`), or null when this is no chat's
 * grant. Never a guest chat's, and only the workspace the chat is bound to.
 */
export async function chatMailClearance(
  ctx: QueryCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string },
): Promise<LiveMailShare[] | null> {
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  const chat = live?.grant.texGroup;
  if (live === null || chat === undefined || chat.guestGroupId !== undefined) return null;
  if (live.grant.workspaceId !== args.expectedWorkspaceId) return null;
  const group = await ctx.db.get(chat.groupId);
  if (group === null || group.workspaceId !== live.grant.workspaceId) return null;
  return await liveMailShares(ctx, group);
}
