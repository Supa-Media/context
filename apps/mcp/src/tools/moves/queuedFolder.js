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
 * `null` means the queue did not take it: the tree does not serve this
 * workspace yet, the storage cannot move an object safely, or the folder
 * holds something this caller cannot see. `move_folder` then moves a folder
 * of up to `LOGICAL_FOLDER_MOVE_THRESHOLD` objects in one go, which leaves
 * what the caller cannot see behind as it always has, and refuses a larger one.
 */

import { withActivityHint } from "../../live/activityHint.js";
import { recordChange } from "../../activity/record.js";
import { canSee, hasOverride, visibilityOf } from "../../privacy/engine.js";
import { probeWithLegacyFallback } from "../../notes/storage.js";
import { toolError, toolText, writePermissionError } from "../results.js";
import { renameCollaboration } from "../../moves/keyedCollaboration.js";

/**
 * A keyed row move's collaboration half: each note the row move renamed carries
 * its history to the new name (`keyedCollaboration.js`). The answer names those
 * files; an answer without them (an older control plane) carries only the root.
 */
async function carryRowedCollaboration(store, answer, source, destination, privacy) {
  if (answer.rowed !== true) return;
  const moved = Array.isArray(answer.moved) ? answer.moved : [{ from: source, to: destination }];
  await renameCollaboration(store, moved, privacy);
}

/** Whether a folder named `a` and one named `b` are the same or one holds the other. */
function nested(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Whether a pending move's old or new name overlaps the move being asked for. */
function crossesPendingMove(moves, source, destination) {
  if (!Array.isArray(moves)) return false;
  return moves.some(
    (move) =>
      typeof move?.from === "string" &&
      typeof move?.to === "string" &&
      [source, destination].some((path) => nested(path, move.from) || nested(path, move.to)),
  );
}

/**
 * A note moved in a keyed workspace as a row change (`rowMoveStart.ts`): the
 * control plane moves the row and says so; nothing is copied here. `null`
 * means the workspace is not keyed yet, and the note moves the old way. A
 * keyed refusal is an answer, never `null`, because the old way would move
 * the frozen copies the bucket still holds.
 */
export async function startKeyedNoteMove(store, scope, source, destination, expectedEtag, privacy) {
  if (store?.keyedLayout !== true || typeof store.startQueuedMove !== "function") return null;
  let answer;
  try {
    answer = await store.startQueuedMove(source, destination, expectedEtag);
  } catch {
    return toolError("could not start the move right now; try again in a moment");
  }
  if (!answer || answer.queued !== true) {
    if (typeof answer?.error !== "string") return null;
    if (answer.error === "FILE_NOT_FOUND") return toolError("not found");
    const message = typeof answer.message === "string" ? answer.message : "the move was refused";
    return toolError(answer.error === "DESTINATION_EXISTS" || answer.error === "CONFLICT" ? `conflict: ${message}` : message);
  }
  await carryRowedCollaboration(store, answer, source, destination, privacy);
  await recordChange(store, "move_note", scope, [source, destination], { rowed: true });
  return withActivityHint(toolText(`moved note: ${source} → ${destination}`), { moves: [{ from: source, to: destination }] });
}

/**
 * A batch of notes moved in a keyed workspace as one control-plane call, made
 * whole or not at all (`/gateway/moves/batch`). The caller's checks are made
 * here first, as `toolMoveNote` makes them for one note, so a source it may not
 * see is "not found" whatever it aimed at. A refusal names nothing the caller
 * cannot see, and the control plane writes every row or none.
 */
export async function startKeyedBatchMove(store, scope, rules, overrides, moves) {
  if (typeof store.startMoveBatch !== "function") {
    return toolError("moving several notes in one call is not available in this workspace yet; move them one at a time");
  }
  for (const move of moves) {
    const seen = canSee(move.source, scope, rules, overrides);
    const present = await probeWithLegacyFallback(store, move.source);
    if (!seen || !present) return toolError(`not found: ${move.source}`);
    if (scope !== "private" && visibilityOf(move.destination, rules) !== "team") {
      return writePermissionError(`move destination ${move.destination}`);
    }
    if (scope === "team" && hasOverride(overrides, move.destination)) return writePermissionError("move destination");
  }
  let answer;
  try {
    answer = await store.startMoveBatch(
      moves.map((move) => ({
        from: move.source,
        to: move.destination,
        ...(move.expectedSourceEtag ? { expectedEtag: move.expectedSourceEtag } : {}),
      })),
    );
  } catch {
    return toolError("could not start the moves right now; try again in a moment");
  }
  if (!answer || answer.ok !== true) {
    if (typeof answer?.error !== "string") return toolError("could not start the moves right now; try again in a moment");
    if (answer.error === "FILE_NOT_FOUND") return toolError("not found");
    const message = typeof answer.message === "string" ? answer.message : "the moves were refused";
    return toolError(answer.error === "DESTINATION_EXISTS" || answer.error === "CONFLICT" ? `conflict: ${message}` : message);
  }
  const pairs = moves.map((move) => ({ from: move.source, to: move.destination }));
  // Each moved note's collaboration history follows it (`keyedCollaboration.js`).
  await renameCollaboration(store, Array.isArray(answer.moves) ? answer.moves : pairs, { rules, overrides });
  await recordChange(store, "move_notes", scope, pairs.flatMap((pair) => [pair.from, pair.to]), { count: pairs.length, rowed: true });
  return withActivityHint(
    toolText(`moved notes: ${pairs.length}\n` + pairs.map((pair) => `- ${pair.from} → ${pair.to}`).join("\n")),
    { moves: pairs },
  );
}

export async function startQueuedFolderMove(store, scope, source, destination, privacy) {
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
    if (typeof answer?.error !== "string") {
      // The old way lists the bucket, which still holds a moving folder at its
      // old name: moving the copied half now and letting the worker bring the
      // rest to the old destination would split the folder.
      if (crossesPendingMove(store.pendingMoves, source, destination)) {
        return toolError("could not move that folder while part of it is still moving; try again once that move finishes");
      }
      return null;
    }
    if (answer.error === "FILE_NOT_FOUND") return toolError("not found");
    const message = typeof answer.message === "string" ? answer.message : "the move was refused";
    return toolError(answer.error === "DESTINATION_EXISTS" || answer.error === "CONFLICT" ? `conflict: ${message}` : message);
  }
  const count = Number.isInteger(answer.count) ? answer.count : 0;
  await carryRowedCollaboration(store, answer, source, destination, privacy);
  await recordChange(store, "move_folder", scope, [source, destination], { count, queued: true });
  // A keyed row move copies nothing, so there is no storage catching up to say.
  const note = answer.rowed === true
    ? "Every app shows it at the new name now."
    : "Every app shows it at the new name now; storage finishes copying in the background, and links to it are rewritten when that is done.";
  return withActivityHint(
    toolText(`moved folder: ${source}/ → ${destination}/ (${count} objects)\n` + note),
    { moves: [{ from: source, to: destination }] }
  );
}
