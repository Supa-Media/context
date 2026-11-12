/**
 * A vault link Tex texted in a group chat (Dev2, 2026-11-12, the Crystal Care
 * chat's Gusto login): the page asks who may use what is saved, with that chat
 * picked already, and shows who in the chat is in the workspace.
 *
 * The chat and its people come from the grant that asked for the link, never
 * from the request: its key (`texChatId`), its account holders (the grant's
 * person and `coViewerIds`) and the people invited by number who haven't
 * joined (`coInvitationIds`), named by the chat's guest label. Never a phone.
 * Who is a member is read live, when the page asks.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { getMembership } from "./workspaceAuth";
import { guestLabel } from "./textGroupGuests";
import { personalWorkspaceOf } from "../textLinks";
import { CHAT_SHARE_PREFIX, EVERYONE } from "../../../mcp/src/vault/access.js";
import type { Share } from "./vaultShapes";
import type { ChatPerson, ChatPeopleRow, RequestChat, ShareChoice } from "./vaultChatShapes";

export { chatPeopleRowValidator, requestChatValidator, shareChoiceValidator } from "./vaultChatShapes";
export type { ChatPeopleRow, RequestChat, ShareChoice } from "./vaultChatShapes";

/** Most people a chat's link names: Sendblue's groups take 25. */
export const MAX_CHAT_PEOPLE = 30;
const CHAT_KEY = /^[0-9a-f]{64}$/;

/** The chat a group grant's link names, its people from the grant itself; null for any other grant. */
export async function requestChatOf(ctx: QueryCtx, grant: Doc<"oauthGrants">, chatKey: string | undefined): Promise<RequestChat | null> {
  if (typeof chatKey !== "string" || !CHAT_KEY.test(chatKey) || grant.texGroup === undefined) return null;
  // A home-only grant is its sponsor's: the chat's accounts are the ones its reach was worked out for, the tagger first.
  const group = grant.texGroup;
  const first = group.homeOnly === true ? group.taggerId : grant.userId;
  const others = group.homeOnly === true ? (group.reachPeople ?? []) : group.coViewerIds;
  const accounts = [...new Set([...(first === undefined ? [] : [first]), ...others])];
  const people: ChatPerson[] = accounts.map((userId) => ({ userId }));
  for (const id of grant.texGroup.coInvitationIds ?? []) {
    const invitation = await ctx.db.get(id);
    if (invitation?.inviteeKind === "phone") people.push({ label: await guestLabel(chatKey, invitation.invitee) });
  }
  return { key: chatKey, people: people.slice(0, MAX_CHAT_PEOPLE) };
}

/** A person's handle (their personal workspace's slug) and name, read for the page. */
async function personOf(ctx: QueryCtx, userId: Id<"users">): Promise<{ name: string | null; handle: string | null }> {
  const user = await ctx.db.get(userId);
  const personal = await personalWorkspaceOf(ctx, userId);
  const slug = personal === null ? null : ((await ctx.db.get(personal))?.slug ?? null);
  const name = typeof user?.name === "string" && user.name.trim() ? user.name.replace(/\s+/g, " ").trim().slice(0, 80) : null;
  return { name, handle: slug };
}

/** What the page shows of the chat: each person and whether they are in the workspace now, the asker first. */
export async function chatPeopleFor(ctx: QueryCtx, workspaceId: Id<"workspaces">, chat: RequestChat, userId: Id<"users">): Promise<ChatPeopleRow[]> {
  const rows: ChatPeopleRow[] = [];
  for (const person of chat.people) {
    if (person.userId === undefined) {
      // Somebody invited by number who hasn't joined (`textGroups.ts` `readyAnswer`): named by the chat's label.
      rows.push({ name: person.label ?? "Someone", handle: null, status: "invited" });
      continue;
    }
    const { name, handle } = await personOf(ctx, person.userId);
    const status = person.userId === userId ? "you" : (await getMembership(ctx, workspaceId, person.userId)) !== null ? "member" : "not_member";
    rows.push({ name: status === "you" ? "You" : (name ?? (handle ? `@${handle}` : "Someone")), handle, status });
  }
  return rows.sort((a, b) => Number(b.status === "you") - Number(a.status === "you"));
}

/** The chat's name on the vault's people list: its people by name, never a number. */
export function chatLabel(rows: ChatPeopleRow[]): string {
  const names = rows.filter((row) => row.status !== "you" && row.status !== "invited").map((row) => row.name);
  const others = rows.filter((row) => row.status === "invited").length;
  const shown = names.slice(0, 3).join(", ");
  const rest = Math.max(0, names.length - 3) + others;
  if (shown === "") return rest > 0 ? `Group chat with ${rest} ${rest === 1 ? "person" : "people"}` : "Group chat";
  return rest > 0 ? `Group chat with ${shown} and ${rest} more` : `Group chat with ${shown}`;
}

/**
 * The shares a save starts with. `chat` gives it to that chat alone (used, never seen); `workspace` to every member
 * of a shared workspace; `me` to nobody but its saver. Null when the choice doesn't fit the link.
 */
export function sharesFor(choice: ShareChoice, { chat, label, kind, userId, now }: { chat: RequestChat | null; label: string; kind: "personal" | "shared"; userId: string; now: number }): Share[] | null {
  if (choice === "me") return [];
  if (choice === "chat") return chat === null ? null : [{ to: `${CHAT_SHARE_PREFIX}${chat.key}`, level: "use", by: userId, at: now, label }];
  return kind === "shared" ? [{ to: EVERYONE, level: "use", by: userId, at: now }] : null;
}
