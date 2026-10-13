/**
 * Pins, "You open most" and Recent following a move made in one go, from
 * inside the credential barrier (phase 4 B2 of
 * `docs/decisions/app-and-console/convex-tree.md`). The rules are read from
 * the bucket here, after the move, and handed to `places.followMoves`, which
 * decides per member and per place (`lib/placesFollow.ts`). Queued moves
 * follow in `nodeMoves.activate`, under the tree's mirror of the same rules.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { loadPrivacyState } from "../fileOps/privacyState";
import type { FileStore } from "../fileOps/store";

/**
 * Hear every move `movePath` made in one go through this store, and carry
 * pins and recents after them once the operation has answered: for everyone
 * who may see where each one went, under the rules the bucket holds now
 * (`lib/placesFollow.ts`). Returns what to call after; best effort, since the
 * move has landed and a place that does not follow just stops showing.
 */
export function attachPlacesFollower(ctx: ActionCtx, workspaceId: Id<"workspaces">, store: FileStore): () => Promise<void> {
  const moves: { from: string; to: string }[] = [];
  Object.defineProperty(store, "onPathMoved", {
    value: (move: { from: string; to: string }) => void moves.push({ from: move.from, to: move.to }),
    enumerable: false,
    configurable: true,
  });
  return () => followPlacesAfter(ctx, workspaceId, store, moves);
}

/**
 * Carry pins and recents after moves that have landed, under the rules the
 * bucket holds now. Best effort: a place that does not follow stops showing.
 */
export async function followPlacesAfter(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  moves: readonly { from: string; to: string }[],
): Promise<void> {
  if (moves.length === 0) return;
  try {
    const state = await loadPrivacyState(store);
    if (state.invalid) return;
    await ctx.runMutation(internal.functions.places.followMoves, {
      workspaceId,
      moves: moves.map((move) => ({ from: move.from, to: move.to })),
      rules: {
        invalid: false,
        folders: state.rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })),
        notes: [...state.overrides].map(([path, visibility]) => ({ path, visibility })),
      },
    });
  } catch {
    console.warn(JSON.stringify({ event: "places.follow_failed", workspaceId }));
  }
}
