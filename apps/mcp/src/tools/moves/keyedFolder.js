/**
 * `move_folder` in a keyed workspace (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * A keyed note's bytes live at its id key, and its name is a row in the
 * control plane's tree, so a folder moves as a row change: the control plane
 * moves the folder's row and every row beneath it, each note keeping its id,
 * its bytes and its access, and the nested folders keeping their shape
 * (`rowMoveStart.ts`). Nothing is copied, flattened or left behind here; the
 * frozen copies still at the old paths are never read or written.
 *
 * A dry run answers from the tree (`tree/served.js`) with the same checks the
 * move makes, so a preflight never says "ok" to a move the control plane
 * refuses on a check made here. The move itself is never made the old way:
 * where the control plane cannot be asked, or does not take it, nothing moves.
 */

import { canSee, effectiveVisibility, hasOverride, isPlumbing, narrowerVisibility, visibilityOf } from "../../privacy/engine.js";
import { listAllKeys } from "../../notes/storage.js";
import { KEYED_PATH_REFUSAL } from "../../store/idLayout.js";
import { servedListingStore, TreeUnavailable } from "../../tree/served.js";
import { nameTwinRefusal, protectedFolderRefusal } from "../../tree/twins.js";
import { destinationRefusal } from "./destination.js";
import { startQueuedFolderMove } from "./queuedFolder.js";
import { toolError, toolText, writePermissionError } from "../results.js";

/** What the control plane says when the folder holds something this caller cannot see (`rowMoveStart.ts`). */
const NOT_IN_ONE_STEP = "conflict: That folder cannot move in one step.";

export async function toolMoveKeyedFolder(store, scope, rules, overrides, source, destination, dryRun) {
  // No control plane to move the rows, no move: and no preflight, which would list the frozen copies.
  if (typeof store?.startQueuedMove !== "function") return toolError(KEYED_PATH_REFUSAL);
  // The same two checks a move the old way makes first, asked of the tree (`tree/twins.js`).
  const locked = await protectedFolderRefusal(store, scope, rules, overrides, source);
  if (locked) return toolError(locked);
  const twin = await nameTwinRefusal(store, scope, rules, overrides, destination, { kind: "folder", ignore: source });
  if (twin) return toolError(twin);
  if (dryRun) return await keyedFolderPreflight(store, scope, rules, overrides, source, destination);
  const moved = await startQueuedFolderMove(store, scope, source, destination, { rules, overrides });
  if (moved !== null) return moved;
  return toolError("could not move that folder right now. Nothing was changed; try again in a moment.");
}

/** The move as the tree has it now: every note and file under `source`, where each lands, and what it may be seen as. */
async function keyedFolderPreflight(store, scope, rules, overrides, source, destination) {
  const sourcePrefix = `${source}/`;
  let listed;
  try {
    listed = (await listAllKeys(servedListingStore(store), sourcePrefix)).filter(({ key }) => !isPlumbing(key));
  } catch (error) {
    if (error instanceof TreeUnavailable) return toolError(error.message);
    throw error;
  }
  const visible = listed.filter(({ key }) => canSee(key, scope, rules, overrides));
  // A folder holding nothing this caller can see is "not found", as one that was never there.
  if (!visible.length) return toolError("not found");
  // A row move takes the whole folder, so one holding anything this caller cannot see is refused as the
  // control plane refuses it, in the same words, which name nothing of what is hidden.
  if (visible.length !== listed.length) return toolError(NOT_IN_ONE_STEP);

  const moves = visible.map(({ key }) => {
    const to = `${destination}/${key.slice(sourcePrefix.length)}`;
    // The narrower of the two, as the move carries it: a folder move never widens a note inside it.
    const visibility = narrowerVisibility(effectiveVisibility(key, rules, overrides), visibilityOf(to, rules));
    return { source: key, destination: to, visibility };
  });
  if (scope !== "private" && moves.some(({ destination: to }) => visibilityOf(to, rules) !== "team")) {
    return writePermissionError("folder move destination");
  }
  if (scope === "team" && moves.some(({ destination: to }) => hasOverride(overrides, to))) {
    return writePermissionError("folder move destination");
  }
  const taken = await destinationRefusal(store, moves.map((move) => move.destination));
  if (taken) return taken;

  const notes = moves.filter((move) => move.source.endsWith(".md")).length;
  const folders = new Set(moves.map((move) => move.destination.slice(0, move.destination.lastIndexOf("/"))));
  return toolText(
    `preflight ok: folder ${source}/ → ${destination}/ (${moves.length} objects: ${notes} notes in ${folders.size} folders)\n` +
      "apply moves every note as itself: the same note ids, content and sharing, every nested folder kept, nothing copied; " +
      "links to and from the moved notes are updated\n" +
      moves.map((move) => `- ${move.source} → ${move.destination} [${move.visibility}]`).join("\n"),
  );
}
