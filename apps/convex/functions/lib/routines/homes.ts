/**
 * A group chat's own routines, kept in its home in the pinned workspace:
 * `tex/groups/<words>/routines/<how-often>/<name>.md` (decided by the owner,
 * 2026-10-31; `docs/decisions/texting-assistant/chat-homes.md`).
 *
 * They are chat routines (`chats.ts`) with two differences, each because the
 * home is sealed to the chat's people rather than open to a workspace's roles:
 *
 *  - The home names the chat, so the `chat:` line is the home's, whatever the
 *    file says, and a home with no chat runs nothing.
 *  - The writer is somebody in the chat, never a member of the pin: who may
 *    write one, and whose phone its turn is tagged with, is read from the
 *    home's row (`textGroups.homeUsers`), live, each time it is asked.
 *
 * Nothing about a home routine is shown on the pin's own pages: its owners
 * can't open the homes, so they can't see what runs there either.
 */

import { homeRoutineWords } from "@context/shared/src/routines.cjs";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { pinnedContextWorkspace } from "../pinnedContext";
import { liveNodeAt } from "../nodes/paths";
import { chatHomePath } from "../textGroupHome";
import { chatRoutineId } from "@context/shared/src/routines.cjs";

/** Most homes one scan reads; more waits, and the scan says it was not whole. */
export const HOME_SCAN_LIMIT = 500;

/** Most routines one home runs, so one chat never crowds out another's. */
export const MAX_ROUTINES_PER_HOME = 25;

/** The home's words when `path` is a home routine (or its folder), else null. */
export function homeOfRoutine(path: string): string | null {
  return homeRoutineWords(path);
}

/** The chat whose home this is, in this workspace, while the workspace is the pin; else null. */
export async function homeChat(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  words: string,
): Promise<Doc<"textGroups"> | null> {
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null || pinned._id !== workspaceId) return null;
  const rows = await ctx.db
    .query("textGroups")
    .withIndex("by_home", (q) => q.eq("homeWords", words))
    .take(2);
  // Two chats on one home is a state nothing writes: neither is it.
  return rows.length === 1 ? rows[0]! : null;
}

/** Whether `userId` is in the chat whose home holds `path` now: the one test of a home routine's writer. */
export async function writesHomeRoutine(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  path: string,
  userId: Id<"users">,
): Promise<boolean> {
  const words = homeOfRoutine(path);
  if (words === null) return false;
  const chat = await homeChat(ctx, workspaceId, words);
  return chat !== null && (chat.homeUsers ?? []).includes(userId);
}

/** The `chat:` a home routine answers into: its home's chat, or null when the home has none. */
export async function homeRoutineChatId(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  path: string,
): Promise<string | null> {
  const words = homeOfRoutine(path);
  if (words === null) return null;
  const chat = await homeChat(ctx, workspaceId, words);
  return chat === null ? null : chatRoutineId(chat.groupKey);
}

/**
 * The chat a home routine runs in now, with its writer's phone: the home's chat, not muted, its key still the one
 * the row names, and the writer still in it with a linked phone. Else null, and the slot passes with `no_chat`.
 */
export async function homeRoutineRun(
  ctx: QueryCtx,
  row: Pick<Doc<"routines">, "workspaceId" | "path" | "chat" | "writerUserId">,
): Promise<{ chat: Doc<"textGroups">; phone: string } | null> {
  const words = homeOfRoutine(row.path);
  if (words === null) return null;
  const chat = await homeChat(ctx, row.workspaceId, words);
  if (chat === null || chat.mutedAt !== undefined) return null;
  if (row.chat === undefined || chatRoutineId(chat.groupKey) !== row.chat) return null;
  if (!(chat.homeUsers ?? []).includes(row.writerUserId)) return null;
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", row.writerUserId))
    .first();
  return link === null ? null : { chat, phone: link.phone };
}

/**
 * Every home's routines folder the scan lists, each with the clearance that opens it: the home's own row token, as
 * the chat's turn holds it (`textGroupHome.ts`). The seal lets no role list a home, an owner's included, so the scan
 * never reads one at the owner's clearance. Empty anywhere but the pin.
 */
export async function homeRoutineFolders(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<{ folders: { path: string; grantedNames: string[] }[]; complete: boolean }> {
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null || pinned._id !== workspaceId) return { folders: [], complete: true };
  const chats = await ctx.db
    .query("textGroups")
    .withIndex("by_home", (q) => q.gt("homeWords", ""))
    .take(HOME_SCAN_LIMIT + 1);
  const folders: { path: string; grantedNames: string[] }[] = [];
  for (const chat of chats.slice(0, HOME_SCAN_LIMIT)) {
    const home = chatHomePath(chat.homeWords!);
    const row = await liveNodeAt(ctx.db, workspaceId, home);
    if (row === null || row.kind !== "folder" || row.noteId === undefined) continue;
    folders.push({ path: `${home}/routines`, grantedNames: [`#${row.noteId}`] });
  }
  return { folders, complete: chats.length <= HOME_SCAN_LIMIT };
}
