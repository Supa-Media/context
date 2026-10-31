/**
 * A shared workspace's chat routine (the owner, 2026-10-27;
 * `docs/decisions/texting-assistant/chat-routines.md`): the group chat its
 * `chat:` names, asked again each time it is handed out.
 *
 * The chat must reach the routine's own workspace now (it is not bound there: every person in the chat is a live
 * member of it, `lib/textGroupReach.ts`), not muted, and
 * not in guest mode: a guest chat reads only what is shared with its group,
 * and a routine runs on the whole workspace's team notes. The run itself goes
 * through the chat's own turn (`textGroups.applyGroupTurn`), which asks again
 * who is in the chat, so a stranger joining stops it there.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { chatReaches } from "../textGroupReach";

/** Most chats one key prefix is read for. */
const CHATS_READ = 200;

/** The chat a routine's `chat:` names in this workspace, while it may hear one; else null. */
export async function routineChat(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  chat: string,
): Promise<Doc<"textGroups"> | null> {
  if (!/^[0-9a-f]{16}$/.test(chat)) return null;
  // Chats are named by a prefix of their key (hex, so `g` is past every one): found by key, then asked whether the
  // routine's workspace is one the chat reaches now (`lib/textGroupReach.ts`), not whether it was ever bound there.
  const rows = await ctx.db
    .query("textGroups")
    .withIndex("by_key", (q) => q.gte("groupKey", chat).lt("groupKey", `${chat}g`))
    .take(CHATS_READ);
  const named = rows.filter((row) => row.groupKey.startsWith(chat));
  // Two chats sharing sixteen hex is a collision nobody chose: neither is it.
  if (named.length !== 1) return null;
  const row = named[0]!;
  if (row.mutedAt !== undefined || row.guestGroupId !== undefined) return null;
  return (await chatReaches(ctx, row, workspaceId)) ? row : null;
}
