/**
 * A GROUP CHAT'S ROUTINES, KEPT IN ITS HOME (the owner, 2026-11-02: reminders move into the chat's own folder, "we
 * have to be able to see it", with the control plane reading only their times;
 * `docs/decisions/texting-assistant/chat-routines.md`).
 *
 * A home is `tex/groups/<words>/` in the pinned workspace, sealed so only its chat's people open it
 * (`lib/nodes/sealedChats.ts`). Its routines are `routines/<how-often>/<name>.md` inside it, read by every rule a
 * routine's path carries as the same path under `tex/routines/` (`homeRoutineOf`). What changes is whose they are:
 *
 *  - the chat is the home's (`textGroups.homeWords`), never what the note's `chat:` says;
 *  - its writer is one of the home's people (`homeUsers`), never a role in the pin, whose owners can't open a home;
 *  - the scan reads the home's rows and front matter from the tree directly, the times and nothing else, as the
 *    pin's owner could not: the seal answers an owner's listing with nothing.
 *
 * The run is a chat routine's: it goes into the chat as its writer's tag, with no grant of its own, and that turn
 * asks again who is in the chat (`runs.ts`, `textGroups.applyGroupTurn`).
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, QueryCtx } from "../../../_generated/server";
import { chatRoutineId, homeRoutineOf } from "@context/shared/src/routines.cjs";
import { CHAT_HOMES_FOLDER } from "@context/shared";
import { rowsBelow } from "../nodes/paths";
import { sealsChatHomes } from "../nodes/sealedChats";
import { writingRole } from "./access";
import { homeScheduleFromNote } from "./model";

/** Most homes one scan reads, and most routines one home keeps. */
export const HOMES_READ = 200;
export const MAX_HOME_ROUTINES = 50;

/** The chat whose home this path is in, or null: none, or two claiming the same words. */
export async function chatOfHome(db: DatabaseReader, path: string): Promise<Doc<"textGroups"> | null> {
  const home = homeRoutineOf(path);
  if (home === null) return null;
  const rows = await db
    .query("textGroups")
    .withIndex("by_home_words", (q) => q.eq("homeWords", home.words))
    .take(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** Whether `userId` may write the home routine at `path`: one of its chat's people, now. */
export async function writesHomeRoutine(db: DatabaseReader, path: string, userId: Id<"users">): Promise<boolean> {
  const chat = await chatOfHome(db, path);
  return chat !== null && (chat.homeUsers ?? []).includes(userId);
}

/**
 * Whether `userId` may be the writer of the routine at `path` here, now: one of its chat's people for a home routine in
 * the pinned workspace, else a role that writes (`writingRole`).
 */
export async function mayWriteRoutine(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  path: string,
  userId: Id<"users">,
): Promise<boolean> {
  if (homeRoutineOf(path) !== null && (await sealsChatHomes(ctx, workspaceId))) return await writesHomeRoutine(ctx.db, path, userId);
  return (await writingRole(ctx, workspaceId, userId)) !== null;
}

/**
 * The chat a home routine row answers into, asked again when it is handed out: the home's chat, still the one the row
 * names, not muted and not a guest chat (which reads only a corner, `chats.ts`), with its writer still among its
 * people. Else null, and the slot passes with `no_chat`.
 */
export async function homeRoutineChat(db: DatabaseReader, row: Pick<Doc<"routines">, "path" | "chat" | "writerUserId">): Promise<Doc<"textGroups"> | null> {
  const chat = await chatOfHome(db, row.path);
  if (chat === null || chat.mutedAt !== undefined || chat.guestGroupId !== undefined) return null;
  if (chatRoutineId(chat.groupKey) !== row.chat) return null;
  return (chat.homeUsers ?? []).includes(row.writerUserId) ? chat : null;
}

/**
 * Every home routine file in the pinned workspace, with the chat each answers into, from the tree's rows: a note
 * directly inside `routines/<how-often>/` of a home whose chat is known. `complete` is false when a cap cut it short.
 */
export async function homeRoutineFiles(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<{ files: { path: string; chat: string }[]; complete: boolean }> {
  if (!(await sealsChatHomes(ctx, workspaceId))) return { files: [], complete: true };
  const db = ctx.db;
  const homes = await db
    .query("textGroups")
    .withIndex("by_home_words", (q) => q.gt("homeWords", ""))
    .take(HOMES_READ + 1);
  let complete = homes.length <= HOMES_READ;
  const files: { path: string; chat: string }[] = [];
  for (const chat of homes.slice(0, HOMES_READ)) {
    const chatId = chatRoutineId(chat.groupKey);
    if (chatId === null || chat.homeWords === undefined) continue;
    const folder = `${CHAT_HOMES_FOLDER}/${chat.homeWords}/routines`;
    const found = (await rowsBelow(db, workspaceId, folder))
      .filter((row) => row.goneAt === undefined && row.kind !== "folder" && homeScheduleFromNote(row.path, "", chatId) !== null)
      .map((row) => row.path);
    if (found.length > MAX_HOME_ROUTINES) complete = false;
    for (const path of found.slice(0, MAX_HOME_ROUTINES)) files.push({ path, chat: chatId });
  }
  return { files, complete };
}
