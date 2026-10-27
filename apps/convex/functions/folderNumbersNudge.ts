/**
 * Nudging a chunked move of a built-in folder that stopped (`rowMoveChunks.ts`).
 *
 * The production report found `4-archive → archive` still `moving` hours
 * after the rename began, with only its root moved. A page that throws every
 * time stops the watchdog for good: `continueRowMove` reschedules itself only
 * from a page that returned. This runs one page of each such move, says what
 * happened, and on success hands the move back to the watchdog.
 *
 * Printed in a public job log: built-in names, page states and an error's
 * words with anything path-like and anything quoted taken out.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import { folderRole } from "@context/shared/src/folderRoles.cjs";
import { errorWords } from "./lib/nodes/folderNumbers";

/** A move this long without a page is stopped, not slow: the watchdog's lease is thirty seconds. */
const STOPPED_MS = 10 * 60_000;
const PAGE = 25;

const builtIn = (path: string): boolean =>
  !path.includes("/") && folderRole(path) !== null;

export const stopped = internalQuery({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    moves: v.array(
      v.object({ id: v.id("rowMoves"), from: v.string(), to: v.string() }),
    ),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const page = await ctx.db
      .query("workspaces")
      .paginate({ cursor: cursor ?? null, numItems: PAGE });
    const moves = [];
    for (const workspace of page.page) {
      const rows = await ctx.db
        .query("rowMoves")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
        .take(50);
      for (const move of rows) {
        if (
          move.state !== "moving" ||
          move.trash ||
          now - move.updatedAt < STOPPED_MS
        )
          continue;
        if (!builtIn(move.from) || !builtIn(move.to)) continue;
        moves.push({ id: move._id, from: move.from, to: move.to });
      }
    }
    return { moves, cursor: page.continueCursor, done: page.isDone };
  },
});

interface NudgePage {
  moves: { from: string; to: string; result: string }[];
  cursor: string;
  done: boolean;
}

export const nudge = internalAction({
  args: { cursor: v.optional(v.string()), dryRun: v.boolean() },
  returns: v.object({
    moves: v.array(
      v.object({ from: v.string(), to: v.string(), result: v.string() }),
    ),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, { cursor, dryRun }): Promise<NudgePage> => {
    const page: {
      moves: { id: Id<"rowMoves">; from: string; to: string }[];
      cursor: string;
      done: boolean;
    } = await ctx.runQuery(
      internal.functions.folderNumbersNudge.stopped,
      cursor === undefined ? {} : { cursor },
    );
    const moves: NudgePage["moves"] = [];
    for (const move of page.moves) {
      if (dryRun) {
        moves.push({ from: move.from, to: move.to, result: "stopped" });
        continue;
      }
      try {
        const answer = await ctx.runMutation(
          internal.functions.nodeRowMoves.rowMovePage,
          { id: move.id },
        );
        // Back to the watchdog: the page just ran, so it waits a lease and goes on.
        await ctx.runMutation(internal.functions.nodeRowMoves.continueRowMove, {
          id: move.id,
        });
        moves.push({
          from: move.from,
          to: move.to,
          result: `${answer.state}, moved ${answer.files.length}, left ${answer.left}`,
        });
      } catch (error) {
        moves.push({
          from: move.from,
          to: move.to,
          result: `threw: ${errorWords(error)}`,
        });
      }
    }
    return { moves, cursor: page.cursor, done: page.done };
  },
});
