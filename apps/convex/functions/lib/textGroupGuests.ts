/**
 * Guest mode for Tex in an iMessage group chat (decided by the owner,
 * 2026-10-25; `docs/decisions/texting-assistant/group-guests.md`).
 *
 * "Tex, use @slug" from an owner or editor of that workspace gives the chat a
 * group of its own there, named with three words, and a folder,
 * `tex/chats/<words>/`, shared with that group to edit. From then on the chat
 * reads only what is shared with its group (`lib/nodes/chatFolders.ts`),
 * whoever is in it, accounts or not, and usage counts against the person who
 * turned it on.
 *
 * The participant list is still never stored. A guest is named in a turn by a
 * label made from a hash of the chat and their number (`guestLabel`), never by
 * the number.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { MAX_GROUPS_PER_WORKSPACE } from "../groups";
import { phoneSignInPaused } from "./emailProof";
import { recordAudit } from "./audit";
import { hashToken } from "./crypto";
import { buildGroupName } from "./names";
import { newNoteId } from "./nodes/noteIds";
import { nodeAt } from "./nodes/paths";
import { granteeInputOf, setAccessRow, type GranteeInput } from "./nodes/setAccess";
import { threeWords } from "./threeWords";
import { unsyncChatPeople } from "./textGroupGuestSync";
import { getMembership } from "./workspaceAuth";

/** Where a guest chat's folder goes: beside, never under, the ordinary chats' memory notes in `tex/groups/` (`apps/mcp/src/agent/groupMemoryNote.js`), whose first note shares that folder only while nothing under it has a setting. */
export const GUEST_FOLDER_ROOT = "tex/chats";
/** How many names are tried before giving up; three words from 180 is about six million names. */
const NAME_TRIES = 12;

/** What a turn is told about a guest chat: its group's full name, the three words, and its folder. */
export type GuestInfo = { group: string; words: string; folder: string };

/** The client every group grant is minted for; the audit names it beside the person. */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";

/** Whether this person may turn guest mode on in this workspace: an owner or editor. */
export async function mayOpenToGuests(ctx: QueryCtx, workspaceId: Id<"workspaces">, userId: Id<"users">): Promise<boolean> {
  const membership = await getMembership(ctx, workspaceId, userId);
  return membership !== null && (membership.role === "owner" || membership.role === "editor");
}

/**
 * Turn guest mode on for a chat in the workspace named `slug`, for `userId`. `null` when that person may not, or no
 * workspace has that name: one answer for both, so "use" tells nobody which names exist. A chat already a guest
 * chat of that workspace keeps its group and folder.
 */
export async function bindGuestChat(
  ctx: MutationCtx,
  chat: Doc<"textGroups">,
  userId: Id<"users">,
  slug: string,
): Promise<{ workspace: Doc<"workspaces">; info: GuestInfo; changed: boolean } | null> {
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  if (workspace === null || !(await mayOpenToGuests(ctx, workspace._id, userId))) return null;

  const kept = await guestOf(ctx, chat);
  if (kept !== null && chat.workspaceId === workspace._id) {
    // The same group and folder; whoever said "use" last is who it counts against.
    if (chat.boundBy !== userId) await ctx.db.patch(chat._id, { boundBy: userId });
    return { workspace, info: kept.info, changed: false };
  }

  const groups = await ctx.db
    .query("workspaceGroups")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .take(MAX_GROUPS_PER_WORKSPACE);
  // A chat moving to another workspace leaves its old group as it found it.
  if (kept !== null) await unsyncChatPeople(ctx, chat);
  if (groups.length >= MAX_GROUPS_PER_WORKSPACE) return null;

  for (let attempt = 0; attempt < NAME_TRIES; attempt += 1) {
    const words = threeWords();
    const built = buildGroupName(workspace.slug, words);
    if (!built.ok) continue;
    const taken = await ctx.db
      .query("names")
      .withIndex("by_name", (q) => q.eq("name", built.normalized))
      .unique();
    const folder = `${GUEST_FOLDER_ROOT}/${words}`;
    if (taken !== null || (await nodeAt(ctx.db, workspace._id, folder)) !== null) continue;
    const now = Date.now();
    const groupId = await ctx.db.insert("workspaceGroups", { workspaceId: workspace._id, name: built.normalized, createdBy: userId, createdAt: now });
    await ctx.db.insert("names", { name: built.normalized, kind: "group", groupId, claimedBy: userId, claimedAt: now });
    await ctx.db.patch(chat._id, {
      workspaceId: workspace._id,
      boundBy: userId,
      guestGroupId: groupId,
      guestFolder: folder,
      guestToken: newNoteId(),
      guestFolderGranted: undefined,
      guestFolderUsers: undefined,
    });
    await recordAudit(ctx, {
      workspaceId: workspace._id,
      actorUserId: userId,
      actorClientId: TEXTS_GROUP_CLIENT_ID,
      action: "texts.group.guests.on",
      paths: [folder],
      details: { group: built.normalized },
    });
    return { workspace, info: { group: built.normalized, words, folder }, changed: true };
  }
  return null;
}

/** The chat's guest group and folder, while its group still exists in the chat's workspace; null otherwise. */
export async function guestOf(
  ctx: QueryCtx,
  chat: Doc<"textGroups">,
): Promise<{ groupId: Id<"workspaceGroups">; info: GuestInfo } | null> {
  if (chat.guestGroupId === undefined || chat.guestFolder === undefined || chat.workspaceId === undefined) return null;
  const group = await ctx.db.get(chat.guestGroupId);
  if (group === null || group.workspaceId !== chat.workspaceId) return null;
  const words = chat.guestFolder.slice(GUEST_FOLDER_ROOT.length + 1);
  return { groupId: group._id, info: { group: group.name, words, folder: chat.guestFolder } };
}

/**
 * Whether a guest chat may still answer: its group is there, and the person who turned it on is still an owner or
 * editor of the workspace with texting not paused. The person it counts against, when it may.
 */
export async function guestBinder(ctx: QueryCtx, chat: Doc<"textGroups">): Promise<Id<"users"> | null> {
  if ((await guestOf(ctx, chat)) === null || chat.boundBy === undefined || chat.workspaceId === undefined) return null;
  if (!(await mayOpenToGuests(ctx, chat.workspaceId, chat.boundBy))) return null;
  if (await phoneSignInPaused(ctx, chat.boundBy)) return null;
  return chat.boundBy;
}

/** Guest mode off: the chat answers as an ordinary group again. The group and folder are left for the owner. */
export async function clearGuests(ctx: MutationCtx, chat: Doc<"textGroups">): Promise<void> {
  if (chat.guestGroupId === undefined && chat.guestFolder === undefined && chat.guestToken === undefined) return;
  // What the chat added for its people goes with it (`textGroupGuestSync.ts`).
  await unsyncChatPeople(ctx, chat);
  await ctx.db.patch(chat._id, {
    guestGroupId: undefined,
    guestFolder: undefined,
    guestToken: undefined,
    guestFolderGranted: undefined,
    guestFolderUsers: undefined,
  });
}

/**
 * Once the chat's folder has a row, give the row the group's grant for real, beside whatever list it carries, so the
 * stand-in (`chatFolders.ts`) is no longer needed. Done under the person who turned guest mode on, as the owner's
 * hand, audited as the group texting client. Best effort: a refusal leaves the stand-in in place.
 *
 * Once only. After that the row is the owner's like any other: one who takes the group's grant off it has hidden the
 * folder from the chat, and neither the stand-in nor a later turn puts it back.
 */
export async function ensureChatFolderGrant(ctx: MutationCtx, chat: Doc<"textGroups">, binder: Id<"users">): Promise<void> {
  if (chat.workspaceId === undefined || chat.guestFolder === undefined || chat.guestGroupId === undefined) return;
  if (chat.guestFolderGranted === true) return;
  const row = await nodeAt(ctx.db, chat.workspaceId, chat.guestFolder);
  if (row === null || row.goneAt !== undefined || row.kind !== "folder") return;
  const grants = await ctx.db
    .query("nodeAccess")
    .withIndex("by_node", (q) => q.eq("nodeId", row._id))
    .collect();
  const granted = async () => void (await ctx.db.patch(chat._id, { guestFolderGranted: true }));
  if (grants.some((grant) => grant.granteeKind === "group" && grant.granteeGroupId === chat.guestGroupId)) return await granted();
  const list: GranteeInput[] = grants.filter((grant) => grant.source === "owner").flatMap((grant) => granteeInputOf(grant) ?? []);
  const answer = await setAccessRow(ctx, {
    workspaceId: chat.workspaceId,
    path: chat.guestFolder,
    base: row.access?.base ?? "inherit",
    grantees: [...list, { kind: "group", groupId: chat.guestGroupId, role: "edit" }],
    kind: "folder",
    actor: { userId: binder, role: "owner", clientId: TEXTS_GROUP_CLIENT_ID },
  });
  if (answer.ok) await granted();
}

/** How a guest is named in a turn: by a hash of the chat and their number, the same in every turn of this chat. */
export async function guestLabel(groupKey: string, phone: string): Promise<string> {
  return `guest-${(await hashToken(`${groupKey}:${phone}`)).slice(0, 4)}`;
}
