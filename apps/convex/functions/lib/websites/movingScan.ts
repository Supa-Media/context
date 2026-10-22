/**
 * A website scan while a folder move is queued (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * A queued move is drawn at once and copied behind: until its last object is
 * copied, a page can sit at its old key while every screen, and every read by
 * name, has it at its new one. A scan that listed the bucket would hand the
 * read its old key, the read answers "not found" for a name a move carried
 * away (`withPendingMoves`), and the scan would drop the page without a word:
 * a Publish pressed a moment after renaming `website/blog` would put the site
 * up without its blog.
 *
 * So while moves are pending a scan lists the tree, which draws them, and
 * reads each page at the name the tree draws (the read moves the object there
 * first). Where that cannot be had — the tree stopped serving, or a move
 * started or turned round under the scan — and the move reaches a folder the
 * scan walked, the scan fails as incomplete, the answer every other unsafe
 * listing gives: a partial listing is never evidence that a page is gone.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { PendingMove } from "../nodes/moveOverlay";
import { scanError } from "./releases";

/** A folder one scan listed, and whether its listing was the tree's, moves drawn. */
export interface ListedFolder {
  folder: string;
  drawn: boolean;
}

export const MOVING_SCAN_MESSAGE =
  "A folder this website uses is being moved. Try again in a moment.";

/** The moves the tree draws now, oldest first. */
export async function pendingMovesNow(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<PendingMove[]> {
  return await ctx.runQuery(internal.functions.nodeRowMoves.drawn, { workspaceId });
}

/** Whether two paths are one, or one holds the other. */
export function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

const moveKey = (move: PendingMove) => `${move.from}\u0000${move.to}`;

/**
 * Fail the scan when a pending move may have hidden a page from it: a move
 * reaching a listed folder whose listing did not draw moves, or one that was
 * not pending when the scan began (it started, or was undone, mid-scan).
 */
export function assertScanSawMoves(
  listed: readonly ListedFolder[],
  before: readonly PendingMove[],
  after: readonly PendingMove[],
): void {
  const known = new Set(before.map(moveKey));
  for (const move of [...before, ...after]) {
    for (const { folder, drawn } of listed) {
      if (!pathsOverlap(move.from, folder) && !pathsOverlap(move.to, folder)) continue;
      if (!drawn || !known.has(moveKey(move))) throw scanError(MOVING_SCAN_MESSAGE);
    }
  }
}
