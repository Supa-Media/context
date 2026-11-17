/**
 * The group chats a person is in, for their own 1:1 Tex (decided by the owner, Dev2, 2026-11-17: "1:1 Tex should be
 * able to see all the groupchats i'm in (that its also connected to) and it should be able to search through any of
 * the messages in there if prompted"; `docs/decisions/texting-assistant/group-reads-from-1to1.md`).
 *
 * The same rule the Tex page and the history export use for "a chat this person is one of the people of":
 * `textGroups.homeUsers` holds them (`texPage.ts` `pageForUser`, `texLedgerExport.ts`). Only Tex's 1:1 texting
 * grant asks, only for the grant's own person and only on their personal workspace, exactly as `texterIdentityHandler`
 * decides who is texting; every refusal is the same `null`. A group chat's grant, a routine, a check-in and any other
 * client learn nothing here, so one chat never lists another.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { resolveGrantByAccessTokenHandler } from "../controlPlane/session";
import { groupName, handleFor } from "../../texPage";
import { personalWorkspaceOf, TEXTS_CLIENT_ID } from "../../textLinks";

/** The rows one ask scans (Tex has few group chats; the Tex page scans the same way) and the most it answers. */
const CHAT_SCAN = 2000;
export const MAX_TEXTER_GROUPS = 40;
const GROUP_KEY = /^[0-9a-f]{64}$/;

export type TexterGroup = { key: string; name: string; people: string[]; lastSeenAt: number };

export async function texterGroupsHandler(ctx: QueryCtx, args: { hashedAccessToken: string; expectedWorkspaceId: string }): Promise<TexterGroup[] | null> {
  const session = await resolveGrantByAccessTokenHandler(ctx, { hashedAccessToken: args.hashedAccessToken });
  if (session === null || session.clientId !== TEXTS_CLIENT_ID) return null;
  const userId = session.actorUserId as Id<"users">;
  const home = await personalWorkspaceOf(ctx, userId);
  if (home === null || home !== args.expectedWorkspaceId) return null;
  if (!session.workspaces.some((entry) => entry.workspaceId === home)) return null;
  return await groupsOfUser(ctx, userId);
}

/** The group chats `userId` is one of the people of, newest first: also what a Lab test of their own 1:1 reads (`texLabSandbox.ts`). */
export async function groupsOfUser(ctx: QueryCtx, userId: Id<"users">): Promise<TexterGroup[]> {
  const mine = (await ctx.db.query("textGroups").take(CHAT_SCAN))
    .filter((chat) => GROUP_KEY.test(chat.groupKey) && (chat.homeUsers ?? []).includes(userId))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_TEXTER_GROUPS);
  const handles = new Map<Id<"users">, Promise<string>>();
  const handleOnce = (id: Id<"users">) => {
    if (!handles.has(id)) handles.set(id, handleFor(ctx, id));
    return handles.get(id) as Promise<string>;
  };
  return await Promise.all(
    mine.map(async (chat) => {
      const names = await Promise.all((chat.homeUsers ?? []).map(async (id) => (id === userId ? "You" : (await handleOnce(id)) || "Someone")));
      const named = typeof chat.chatName === "string" && chat.chatName.trim() !== "";
      return { key: chat.groupKey, name: named ? (chat.chatName as string).trim() : groupName(names), people: names.filter((name) => name !== "You"), lastSeenAt: chat.lastSeenAt };
    }),
  );
}
