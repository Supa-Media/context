/**
 * Retiring Tex's guest chats (the owner, 2026-10-31; `docs/decisions/texting-assistant/group-guests.md`).
 *
 * A guest chat kept its notes in a folder of its own, `tex/chats/<words>/`, in the workspace it was bound to. Guest
 * mode is gone, and a chat with people who aren't all here is answered from its home, `tex/groups/<words>/` in the
 * pinned workspace. So each such chat's whole folder, the notes its members wrote in it included, is moved into its
 * home, and the chat's guest fields, group members and phone numbers are cleared once the move is done.
 *
 * The move is the ordinary cross-context one (`functions/contextMoves.ts`: its batches, its conflict handling, its
 * resumability), started by the system for the chat and marked so (`lib/contextMoveChatHome.ts`). Run from the
 * `Tex guest chats retire` workflow: first with `dryRun` (counts only, nothing written), then for real, paging with the
 * cursor until `finished`. The answer is counts and fixed codes only, never a path, a name or a key: this repository
 * is public, and so is that job's log. Running it again is safe: a chat with a move under way is left to it, a failed
 * move is picked up where it stopped, and a chat that is retired is no longer a guest chat to find.
 * Internal only, so only the workflow's own deploy key can start it.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { chatHomeMoveAccess, guestFolderHoldsNotes, openChatHomeMove } from "./lib/contextMoveChatHome";
import { normalizeMovePath } from "./lib/contextMoveAuthorize";
import { clearGuests } from "./lib/textGroupGuests";

/** Chats looked at in one call of `run`. */
const PAGE = 40;
/** The most passes a chat's move may chain, as the console's does. */
const MAX_PASSES = 2_000;

const accessValidator = v.object({ scope: v.union(v.literal("private"), v.literal("team")), grantedNames: v.array(v.string()) });

/**
 * What a chat's move may do on this pass, or `null` when its row is not exactly the chat's folder into the chat's
 * home. The engine asks this on every pass in place of a person's roles.
 */
export const chatHomeAccess = internalQuery({
  args: { moveId: v.id("contextMoves") },
  returns: v.union(v.null(), v.object({ source: accessValidator, destination: accessValidator })),
  handler: async (ctx, { moveId }) => {
    const row = await ctx.db.get(moveId);
    if (row === null || row.chatHome === undefined) return null;
    return await chatHomeMoveAccess(ctx, { ...row, chatHome: row.chatHome });
  },
});

/** The chat's folder is in its home: guest mode's fields, people and numbers go. Only for the chat the move is for. */
export const finishChat = internalMutation({
  args: { moveId: v.id("contextMoves") },
  returns: v.null(),
  handler: async (ctx, { moveId }) => {
    const row = await ctx.db.get(moveId);
    if (row === null || row.chatHome === undefined) return null;
    const chat = await ctx.db.get(row.chatHome.groupId);
    if (chat === null || chat.guestFolder === undefined) return null;
    if (normalizeMovePath(chat.guestFolder) !== row.from || chat.workspaceId !== row.sourceWorkspaceId) return null;
    await clearGuests(ctx, chat);
    return null;
  },
});

/** One page of chats, the guest ones among them. */
export const page = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ ids: v.array(v.id("textGroups")), cursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    const found = await ctx.db.query("textGroups").paginate({ cursor, numItems: PAGE });
    return {
      ids: found.page.filter((chat) => chat.guestGroupId !== undefined).map((chat) => chat._id),
      cursor: found.continueCursor,
      isDone: found.isDone,
    };
  },
});

const outcomeValidator = v.union(
  v.object({ kind: v.literal("moveStarted") }),
  v.object({ kind: v.literal("wouldMove") }),
  v.object({ kind: v.literal("moving") }),
  v.object({ kind: v.literal("done") }),
  v.object({ kind: v.literal("refused"), code: v.string() }),
);

/**
 * One chat: nothing in its folder, so it is cleared at once; a move under way, left to it; a failed one, started again
 * where it stopped; otherwise a move is opened. With `dryRun` it only says which of these it would do.
 */
export const retireChat = internalMutation({
  args: { chatId: v.id("textGroups"), dryRun: v.boolean() },
  returns: outcomeValidator,
  handler: async (ctx, { chatId, dryRun }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null || chat.guestGroupId === undefined) return { kind: "done" as const };
    const moves = await ctx.db.query("contextMoves").withIndex("by_chat_home", (q) => q.eq("chatHome.groupId", chatId)).order("desc").take(5);
    if (moves.some((move) => move.status === "moving")) return { kind: "moving" as const };
    // A move that finished but whose clearing did not: the folder is in the home, so the chat is cleared now.
    if (moves.some((move) => move.status === "complete")) {
      if (!dryRun) await clearGuests(ctx, chat);
      return { kind: "done" as const };
    }
    const failed = moves.find((move) => move.status === "failed");
    if (failed === undefined && !(await guestFolderHoldsNotes(ctx, chat))) {
      if (!dryRun) await clearGuests(ctx, chat);
      return { kind: "done" as const };
    }
    if (dryRun) return { kind: "wouldMove" as const };
    if (failed !== undefined) {
      await ctx.db.patch(failed._id, { status: "moving", error: undefined, completedAt: undefined, updatedAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.functions.contextMoves.advanceContextMove, { moveId: failed._id, passesLeft: MAX_PASSES });
      return { kind: "moveStarted" as const };
    }
    const opened = await openChatHomeMove(ctx, chatId);
    if ("refused" in opened) return { kind: "refused" as const, code: opened.refused };
    await ctx.scheduler.runAfter(0, internal.functions.contextMoves.advanceContextMove, { moveId: opened.moveId, passesLeft: MAX_PASSES });
    return { kind: "moveStarted" as const };
  },
});

export type RetirePage = {
  chats: number;
  wouldMove: number;
  started: number;
  moving: number;
  done: number;
  refused: Record<string, number>;
  cursor: string;
  finished: boolean;
};

/**
 * One page of the retirement. Counts only. `dryRun` writes nothing: `wouldMove` counts the chats a real run would
 * start a move for, and `done` those it would clear without one. Page with `cursor` until `finished`.
 */
export const run = internalAction({
  args: { dryRun: v.boolean(), cursor: v.optional(v.string()) },
  returns: v.object({
    chats: v.number(),
    wouldMove: v.number(),
    started: v.number(),
    moving: v.number(),
    done: v.number(),
    refused: v.record(v.string(), v.number()),
    cursor: v.string(),
    finished: v.boolean(),
  }),
  handler: async (ctx, args): Promise<RetirePage> => {
    const found: { ids: Id<"textGroups">[]; cursor: string; isDone: boolean } = await ctx.runQuery(internal.functions.texGuestRetire.page, { cursor: args.cursor ?? null });
    const counts: RetirePage = { chats: found.ids.length, wouldMove: 0, started: 0, moving: 0, done: 0, refused: {}, cursor: found.cursor, finished: found.isDone };
    for (const chatId of found.ids) {
      const outcome = await ctx.runMutation(internal.functions.texGuestRetire.retireChat, { chatId, dryRun: args.dryRun });
      if (outcome.kind === "wouldMove") counts.wouldMove += 1;
      else if (outcome.kind === "moveStarted") counts.started += 1;
      else if (outcome.kind === "moving") counts.moving += 1;
      else if (outcome.kind === "done") counts.done += 1;
      else counts.refused[outcome.code] = (counts.refused[outcome.code] ?? 0) + 1;
    }
    return counts;
  },
});
