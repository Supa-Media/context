/**
 * A chunked row move's pages run with no request behind them (`nodeRowMoves.continueRowMove`, the watchdog, and the
 * folder-numbers nudge), told to the workspace's object first (`lib/rowWatch/objectFirst.ts`).
 *
 * A page moves rows, and a moved row may land where someone who saw it no longer can. A mutation cannot ask the
 * object, so the page runs from here: the mark is opened, the page's mutation commits, and the mark closes once the
 * object has the rows. A page whose mark the object refused does not run; the watchdog tries again a lease later.
 * Kept apart from `nodeRowMoves.ts`, which defines the mutations, so the object's door is never loaded beside them.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { objectFirst } from "./lib/rowWatch/objectFirst";
import { ObjectUnreachable } from "./lib/rowWatch/objectDoor";
import { ROW_MOVE_LEASE_MS } from "./lib/nodes/rowMoveChunks";

type Page = { state: "moving" | "done" | "rules_changed" | "gone"; files: { from: string; to: string }[]; left: number };

/** One page of the chunked move `id`, with a mark open in its workspace's object. `gone` once the move is. */
export async function markedRowMovePage(ctx: ActionCtx, id: Id<"rowMoves">): Promise<Page> {
  const workspaceId = await ctx.runQuery(internal.functions.nodeRowMoves.moveWorkspace, { id });
  if (workspaceId === null) return { state: "gone", files: [], left: 0 };
  return await objectFirst(ctx, workspaceId, () => ctx.runMutation(internal.functions.nodeRowMoves.rowMovePage, { id }));
}

/**
 * The watchdog's page: moved here, then back to the watchdog, which waits a lease while the move goes on and
 * settles it once it is done, as it did when it moved the page itself. A move whose rules changed waits to be asked
 * again (`rowMoveDrive.ts`), so nothing is scheduled for it.
 */
export const watchdogPage = internalAction({
  args: { id: v.id("rowMoves") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    let page: Page;
    try {
      page = await markedRowMovePage(ctx, id);
    } catch (error) {
      // The object would not take the mark: nothing moved, and the watchdog looks again a lease later. Any other
      // failure ends the watchdog as a throw in its own page did; asking for the move again resumes it.
      if (!(error instanceof ObjectUnreachable)) throw error;
      console.warn(JSON.stringify({ event: "row_move_watchdog_unmarked", reason: error.message }));
      await ctx.scheduler.runAfter(ROW_MOVE_LEASE_MS, internal.functions.nodeRowMoves.continueRowMove, { id });
      return null;
    }
    if (page.state === "moving" || page.state === "done") await ctx.runMutation(internal.functions.nodeRowMoves.continueRowMove, { id });
    return null;
  },
});
