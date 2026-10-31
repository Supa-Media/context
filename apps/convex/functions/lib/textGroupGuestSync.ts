/**
 * What guest mode added to a workspace, taken back (`docs/decisions/texting-assistant/group-guests.md`, retired by the
 * owner on 2026-10-31). A legacy chat's group and folder rows are cleared by `unsyncChatPeople`, and the guest phone
 * pass names an account made for a number on the chat's folder (`nameOutsider`). Nothing here adds people any more:
 * a chat with people who aren't all here is answered from its home (`lib/textGroupHomeOnly.ts`).
 *
 * Only people already linked to an account are ever written, by account id.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { MAX_MEMBERS_PER_GROUP } from "../groups";
import { nodeAt } from "./nodes/paths";
import { granteeInputOf, setAccessRow, type GranteeInput } from "./nodes/setAccess";

const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
/** Most outsiders one chat names on its folder: a chat holds at most 32 people. */
const MAX_FOLDER_PEOPLE = 32;

/**
 * An account that has just been made for a number in the chat (`guestPass.ts`) is named on the chat's folder to edit,
 * as the next tag would name it, rather than made a member of the group: a group row reaches nothing for someone who
 * isn't a member, and a member is an invitation, which is the owner's. Waits for the folder's grant, like the tag does.
 */
export async function nameOutsider(ctx: MutationCtx, chat: Doc<"textGroups">, userId: Id<"users">): Promise<void> {
  if (chat.boundBy === undefined) return;
  const wanted = [...(chat.guestFolderUsers ?? [])];
  if (!wanted.includes(userId)) wanted.push(userId);
  await syncFolderPeople(ctx, chat, chat.boundBy, wanted.slice(0, MAX_FOLDER_PEOPLE));
}

/** Everything the chat added, taken back: guest mode is off. */
export async function unsyncChatPeople(ctx: MutationCtx, chat: Doc<"textGroups">): Promise<void> {
  if (chat.workspaceId !== undefined && chat.guestGroupId !== undefined) {
    await syncGroupRows(ctx, chat.workspaceId, chat.guestGroupId, chat._id, null, []);
  }
  if (chat.boundBy !== undefined) await syncFolderPeople(ctx, chat, chat.boundBy, []);
}

async function syncGroupRows(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  groupId: Id<"workspaceGroups">,
  chatId: Id<"textGroups">,
  actor: Id<"users"> | null,
  members: Id<"users">[],
): Promise<void> {
  const rows = await ctx.db
    .query("workspaceGroupMembers")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .take(MAX_MEMBERS_PER_GROUP);
  const wanted = new Set(members);
  for (const row of rows) {
    if (row.viaChat === chatId && !wanted.has(row.userId)) await ctx.db.delete(row._id);
  }
  if (actor === null) return;
  let count = rows.filter((row) => row.viaChat !== chatId || wanted.has(row.userId)).length;
  const named = new Set(rows.map((row) => row.userId));
  for (const userId of wanted) {
    if (named.has(userId) || count >= MAX_MEMBERS_PER_GROUP) continue;
    await ctx.db.insert("workspaceGroupMembers", { groupId, workspaceId, userId, addedBy: actor, addedAt: Date.now(), viaChat: chatId });
    count += 1;
  }
}

/**
 * The outsiders named on the chat's folder row: the ones the chat named before come off, the ones in it now go on,
 * and everything else on the list stays. Waits for the row to exist and to have had the group's grant, so the first
 * write of the list is `ensureChatFolderGrant`'s.
 */
async function syncFolderPeople(ctx: MutationCtx, chat: Doc<"textGroups">, actor: Id<"users">, wanted: Id<"users">[]): Promise<void> {
  if (chat.workspaceId === undefined || chat.guestFolder === undefined || chat.guestFolderGranted !== true) return;
  const row = await nodeAt(ctx.db, chat.workspaceId, chat.guestFolder);
  if (row === null || row.goneAt !== undefined || row.kind !== "folder") return;
  const grants = await ctx.db
    .query("nodeAccess")
    .withIndex("by_node", (q) => q.eq("nodeId", row._id))
    .collect();
  // An owner who took the folder back from the chat's group took it back from the chat's people too.
  const shared = grants.some((grant) => grant.granteeKind === "group" && grant.granteeGroupId === chat.guestGroupId);
  const outsiders = shared ? wanted : [];
  const before = chat.guestFolderUsers ?? [];
  if (before.length === outsiders.length && before.every((userId) => outsiders.includes(userId))) return;
  const ours = new Set<string>([...before, ...outsiders]);
  const kept: GranteeInput[] = grants
    .filter((grant) => grant.source === "owner")
    .filter((grant) => !(grant.granteeKind === "user" && grant.granteeUserId !== undefined && ours.has(grant.granteeUserId)))
    .flatMap((grant) => granteeInputOf(grant) ?? []);
  const answer = await setAccessRow(ctx, {
    workspaceId: chat.workspaceId,
    path: chat.guestFolder,
    base: row.access?.base ?? "inherit",
    grantees: [...kept, ...outsiders.map((userId) => ({ kind: "user" as const, userId, role: "edit" as const }))],
    kind: "folder",
    actor: { userId: actor, role: "owner", clientId: TEXTS_GROUP_CLIENT_ID },
  });
  if (answer.ok) await ctx.db.patch(chat._id, { guestFolderUsers: outsiders.length > 0 ? outsiders : undefined });
}
