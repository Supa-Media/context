/**
 * A rename or move made in the console reaches the tree the moment its bytes
 * land, not when the whole operation answers.
 *
 * `movePath` copies the note (or folder), carries its privacy rules, records
 * the forwarding address, and then rewrites every link that points at what
 * moved. That last step can read every note the mover can see, one at a time,
 * so on a workspace of a few hundred notes it took longer than the move
 * itself, and the tree (which every other tab, the phone, the map and agents
 * list from) only heard of the move after it, from the barrier's after-change
 * re-check. This re-checks the two names and `privacy.md` in between, so the
 * new name is drawn everywhere while the links are still being repaired. The
 * after-change re-check still runs and sees the same thing.
 *
 * Only for a person's own `move`: the organizer moves many notes in one
 * operation and re-checks them at its end.
 */

import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps/store";
import { NODE_PRIVACY_KEY } from "./table";
import { touchNodesNow } from "./run";

/**
 * Give `store` the `onMoveLanded` seam `movePath` awaits (non-enumerable, as
 * the barrier's other seams are). `bucket` is what the re-check lists.
 */
export function attachLandedTouch(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  bucket: FileStore,
): void {
  Object.defineProperty(store, "onMoveLanded", {
    value: async (move: { from: string; to: string }) =>
      await touchNodesNow(ctx, workspaceId, bucket, { paths: [move.from, move.to], files: [NODE_PRIVACY_KEY] }),
    enumerable: false,
    configurable: true,
  });
}
