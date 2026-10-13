/**
 * `move_folder` as one step, however big the folder (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * Where the control plane's tree serves this workspace, the move is queued
 * there exactly as the console queues one: every screen draws the folder at
 * its new name at once, and the bucket catches up behind it. The control
 * plane decides everything the console's move decides (who may move what,
 * whether the destination exists, what the moved notes may be seen as), so
 * this file only asks and words the answer.
 *
 * `null` means "move it here, the old way": the tree does not serve this
 * workspace yet, staff paused it, or the folder holds something this caller
 * cannot see, which the old way leaves behind as it always has.
 */

import { withActivityHint } from "../../live/activityHint.js";
import { recordChange } from "../../activity/record.js";
import { toolError, toolText } from "../results.js";

export async function startQueuedFolderMove(store, scope, source, destination) {
  if (typeof store?.startQueuedMove !== "function") return null;
  let answer;
  try {
    answer = await store.startQueuedMove(source, destination);
  } catch {
    // With a move already running, the old way could act on names that are still
    // moving. Without one, the old way is exactly what this did before.
    if (Array.isArray(store.pendingMoves) && store.pendingMoves.length > 0) {
      return toolError("could not start the move right now; try again in a moment");
    }
    return null;
  }
  if (!answer || answer.queued !== true) {
    if (typeof answer?.error !== "string") return null;
    if (answer.error === "FILE_NOT_FOUND") return toolError("not found");
    const message = typeof answer.message === "string" ? answer.message : "the move was refused";
    return toolError(answer.error === "DESTINATION_EXISTS" || answer.error === "CONFLICT" ? `conflict: ${message}` : message);
  }
  const count = Number.isInteger(answer.count) ? answer.count : 0;
  await recordChange(store, "move_folder", scope, [source, destination], { count, queued: true });
  return withActivityHint(
    toolText(
      `moved folder: ${source}/ → ${destination}/ (${count} objects)\n` +
        "Every app shows it at the new name now; storage finishes copying in the background, and links to it are rewritten when that is done."
    ),
    { moves: [{ from: source, to: destination }] }
  );
}
