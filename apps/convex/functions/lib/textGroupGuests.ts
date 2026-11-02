/**
 * What is left of guest mode for Tex in an iMessage group chat (retired by the owner on 2026-10-31;
 * `docs/decisions/texting-assistant/group-guests.md`).
 *
 * Guest mode used to give a chat a group and folder of its own in a workspace it named. It is retired: a chat with
 * people who aren't all here is answered from its home (`lib/textGroupHomeOnly.ts`). What stays here:
 *
 *  - `mayOpenToGuests`: an owner or editor, which invited family and a guest's home still need;
 *  - `guestLabel`: how a person with no account is named in a turn, by a hash of the chat and their number;
 *  - `guestBinder`, `clearGuests` and `ensureChatFolderGrant`: the legacy guest group and folder. The guest phone
 *    pass asks `guestBinder` whether a legacy chat may still answer (`guestPass.ts`); `clearGuests` is used by the
 *    one-off that moves them (`functions/texGuestRetire.ts`) and by `textGroups.ts`.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { clearChatPhones } from "./guestPhones";
import { hashToken } from "./crypto";
import { phoneSignInPaused } from "./emailProof";
import { nodeAt } from "./nodes/paths";
import { granteeInputOf, setAccessRow, type GranteeInput } from "./nodes/setAccess";
import { unsyncChatPeople } from "./textGroupGuestSync";
import { getMembership } from "./workspaceAuth";

/** The client every group grant is minted for; the audit names it beside the person. */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";

/** Whether this person may open a workspace to a chat: an owner or editor. */
export async function mayOpenToGuests(ctx: QueryCtx, workspaceId: Id<"workspaces">, userId: Id<"users">): Promise<boolean> {
  const membership = await getMembership(ctx, workspaceId, userId);
  return membership !== null && (membership.role === "owner" || membership.role === "editor");
}

/**
 * Whether a legacy guest chat may still answer: its group is there, and the person who turned guest mode on is still
 * an owner or editor of the workspace with texting not paused. The person it counts against, when it may.
 */
export async function guestBinder(ctx: QueryCtx, chat: Doc<"textGroups">): Promise<Id<"users"> | null> {
  if (chat.guestGroupId === undefined || chat.guestFolder === undefined || chat.boundBy === undefined || chat.workspaceId === undefined) return null;
  const group = await ctx.db.get(chat.guestGroupId);
  if (group === null || group.workspaceId !== chat.workspaceId) return null;
  if (!(await mayOpenToGuests(ctx, chat.workspaceId, chat.boundBy))) return null;
  if (await phoneSignInPaused(ctx, chat.boundBy)) return null;
  return chat.boundBy;
}

/** Guest mode off for a legacy chat: what the chat added for its people goes with it (`textGroupGuestSync.ts`). */
export async function clearGuests(ctx: MutationCtx, chat: Doc<"textGroups">): Promise<void> {
  if (chat.guestGroupId === undefined && chat.guestFolder === undefined && chat.guestToken === undefined) return;
  // What the chat added for its people goes with it (`textGroupGuestSync.ts`).
  await unsyncChatPeople(ctx, chat);
  await clearChatPhones(ctx, chat._id);
  await ctx.db.patch(chat._id, {
    guestGroupId: undefined,
    guestFolder: undefined,
    guestToken: undefined,
    guestFolderGranted: undefined,
    guestFolderUsers: undefined,
  });
}

/**
 * Once a legacy chat's folder has a row, give the row the group's grant for real, beside whatever list it carries.
 * Done under the person who turned guest mode on, as the owner's hand, audited as the group texting client. Best
 * effort: a refusal changes nothing. Once only.
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

/** How a person with no account is named in a turn: by a hash of the chat and their number, the same in every turn of this chat. */
export async function guestLabel(groupKey: string, phone: string): Promise<string> {
  return `guest-${(await hashToken(`${groupKey}:${phone}`)).slice(0, 4)}`;
}
