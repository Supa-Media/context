/**
 * A guest chat's own folder moving into that chat's own home (owner-approved, 2026-10-31; guest mode is retired,
 * `docs/decisions/texting-assistant/group-guests.md`).
 *
 * The cross-context move engine (`functions/contextMoves.ts`) authorizes a person: owner of the source, editor of the
 * destination, asked again on every pass. A chat is not a person, and the pinned workspace refuses every move into a
 * home (`chatHomesMoveRefused`, and a sealed path is seen by name alone). So this one move has a marker on its row,
 * `chatHome: {groupId}`, and while it is set the roles are replaced by a check of the database, on every pass:
 *
 *  - the source is the workspace the chat is bound to, and `from` is the chat's guest folder;
 *  - the destination is the vouched pinned workspace (`pinnedContextWorkspace`), and `to` is that chat's own home;
 *  - nothing else. Another chat's folder, another path, another home or another workspace is `null`, and the move stops.
 *
 * Nothing but `openChatHomeMove` sets the marker: it is only called from an internal mutation, `openMove` (the
 * console's and the gateway route's) has no such argument, and `reopenMove` refuses a row that carries it.
 *
 * The destination is read at the home's own scope: private, plus the home's row tokens. The path is sealed, so a role
 * opens nothing there and the tokens open exactly this home, which is also why arrivals land sealed.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { normalizeMovePath } from "./contextMoveAuthorize";
import { pinnedContextWorkspace } from "./pinnedContext";
import { subtreeOf } from "./nodes/rowMove";
import { chatHomeOf, ensureChatHome } from "./textGroupHome";

export type MoveAccess = { scope: "private" | "team"; grantedNames: string[] };

/** The words a refusal is counted under; fixed, so a public log never carries a path or a name. */
export type ChatHomeRefusal = "NO_CHAT" | "NO_FOLDER" | "NOT_BOUND" | "NO_PIN" | "NO_ACTOR" | "NO_HOME";

type MoveEnds = {
  sourceWorkspaceId: Id<"workspaces">;
  destinationWorkspaceId: Id<"workspaces">;
  from: string;
  to: string;
};

/**
 * What a chat-home move may do, or `null` when the row is not exactly that chat's folder into that chat's home.
 * Re-derived from the chat's row, the pin and the home's row; nothing the move row says is taken on trust but the
 * chat it names.
 */
export async function chatHomeMoveAccess(
  ctx: QueryCtx,
  row: MoveEnds & { chatHome: { groupId: Id<"textGroups"> } },
): Promise<{ source: MoveAccess; destination: MoveAccess } | null> {
  const chat = await ctx.db.get(row.chatHome.groupId);
  if (chat === null || chat.workspaceId === undefined || chat.guestFolder === undefined) return null;
  if (row.sourceWorkspaceId !== chat.workspaceId) return null;
  if (normalizeMovePath(row.from) !== normalizeMovePath(chat.guestFolder)) return null;
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null || row.destinationWorkspaceId !== pinned._id || row.sourceWorkspaceId === pinned._id) return null;
  const home = await chatHomeOf(ctx, chat._id);
  if (home === null || home.workspaceId !== pinned._id) return null;
  if (normalizeMovePath(row.to) !== home.folder) return null;
  const token = `#${home.noteId}`;
  return {
    source: { scope: "private", grantedNames: [] },
    destination: { scope: "private", grantedNames: [token, `${token}!edit`] },
  };
}

/** Who a chat's move is recorded under, and who is named on its home when the move has to make one. */
function homeActor(chat: Doc<"textGroups">): Id<"users"> | null {
  return chat.sponsorId ?? chat.boundBy ?? null;
}

/** Whether the chat's guest folder holds any live note, so there is something for a move to carry. */
export async function guestFolderHoldsNotes(ctx: QueryCtx, chat: Doc<"textGroups">): Promise<boolean> {
  if (chat.workspaceId === undefined || chat.guestFolder === undefined) return false;
  const tree = await subtreeOf(ctx.db, chat.workspaceId, chat.guestFolder, 8);
  return tree.root !== null && tree.below.some((entry) => entry.kind === "file");
}

/**
 * The row for a chat's move, making its home first if it has none. Answers the new row's id, or the fixed reason it
 * cannot be made. The caller looks for a row of this chat that is still moving, or failed, before asking for another.
 */
export async function openChatHomeMove(
  ctx: MutationCtx,
  groupId: Id<"textGroups">,
): Promise<{ moveId: Id<"contextMoves"> } | { refused: ChatHomeRefusal }> {
  const chat = await ctx.db.get(groupId);
  if (chat === null) return { refused: "NO_CHAT" };
  if (chat.workspaceId === undefined) return { refused: "NOT_BOUND" };
  if (chat.guestFolder === undefined) return { refused: "NO_FOLDER" };
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null || pinned._id === chat.workspaceId) return { refused: "NO_PIN" };
  const actor = homeActor(chat);
  if (actor === null) return { refused: "NO_ACTOR" };
  // A home that is not there yet is made for the people the chat already names; its next tag names the rest.
  if ((await chatHomeOf(ctx, groupId)) === null) {
    const people = [...new Set([actor, ...(chat.homeUsers ?? []), ...(chat.guestFolderUsers ?? [])])];
    await ensureChatHome(ctx, chat, people, actor);
  }
  const home = await chatHomeOf(ctx, groupId);
  if (home === null) return { refused: "NO_HOME" };
  const now = Date.now();
  const moveId = await ctx.db.insert("contextMoves", {
    sourceWorkspaceId: chat.workspaceId,
    destinationWorkspaceId: pinned._id,
    actorUserId: actor,
    from: normalizeMovePath(chat.guestFolder),
    to: home.folder,
    status: "moving",
    movedObjects: 0,
    movedBytes: 0,
    skipped: [],
    chatHome: { groupId },
    createdAt: now,
    updatedAt: now,
  });
  return { moveId };
}
