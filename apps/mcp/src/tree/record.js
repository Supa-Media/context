/**
 * Which recorded changes the Convex tree re-checks, and how.
 *
 * `recordChange` is the one call every gateway write makes afterwards, so it
 * is where the control plane hears about them (`reportTreeTouch`,
 * `activity/record.js`). A change to the tree's shape — a note created,
 * moved, archived, a folder moved — has every path it names re-checked as a
 * note and as a folder. A write that only puts text in a note has that key
 * alone re-checked, and a save of an existing note's body (`update_note`) is
 * gathered with others as `edited` (`treeEditsOf`): the live editor commits
 * every typing pause, and a re-check per pause is cost with nothing to show.
 *
 * The search database's own tree table, which these once re-checked too, was
 * retired in phase 7 of `docs/decisions/app-and-console/convex-tree.md`
 * (`tree/retired.js`).
 */

import { sendsTreeHint } from "../activity/changes.js";
import { GROUP_SCOPE_PATTERN } from "../privacy/engine.js";

/** Writes that put text in a note, which may be a note that was not there before. */
const WRITES = new Set([
  "create_note",
  "remember_fact",
  "save_context",
  "meeting_note",
  "propose_note",
  "rewrite_references",
  "inbox_capture",
  "inbox_update",
  "calendar_sync",
  "approve_proposal",
]);

/**
 * Changes whose real effect is in `privacy.md`, not in the path they name.
 *
 * `set_visibility` records the note and `set_folder_visibility` the folder,
 * because that is what a person reads in the activity feed — but the bytes
 * that changed are the manifest's. The control plane keeps a mirror of the
 * rules and refreshes it only when a touch names that file
 * (`lib/nodes/touch.ts`), and from the Convex tree's phase 2 a folder listing
 * is decided from the mirror. A touch that named only the note would leave
 * the mirror holding rules the owner has already taken back.
 */
const PRIVACY_WRITERS = new Set(["set_visibility", "set_folder_visibility"]);

/**
 * Saves that change only a note's text, so its version and size, and nothing
 * of the tree's shape. The Convex tree hears of them as `edited`
 * (`treeEditsOf`), which the control plane gathers for a few seconds
 * before re-checking. Without it the Convex rows kept the version from the
 * last sweep (up to an hour), so the desktop and phone apps, which follow its
 * change log, never heard of an edit made on the web until then.
 */
const TEXT_SAVES = new Set([
  "update_note",
  "encrypt_note",
  "decrypt_note",
  // A form answer rewrites its response note's text (`tools/forms/responses.js`).
  "submit_form",
  "update_submission",
  "retract_submission",
  "vote_form",
]);

/** Moves of one note, whose source's visibility before the move the tool records. */
const ONE_NOTE_MOVES = new Set(["move_note", "archive_note"]);

/** Moves whose paths come in pairs, old then new, so the chaos score can carry what it knew. */
const PAIRED_MOVES = new Set(["move_note", "archive_note", "move_folder", "materialize_move", "move_notes"]);

/** `[old, new]` pairs from a move's paths, or none when they are not plainly pairs. */
function movesOf(action, named, details) {
  if (!PAIRED_MOVES.has(action) || details?.partial === true || named.length % 2 !== 0) return [];
  const moves = [];
  for (let index = 0; index < named.length; index += 2) moves.push([named[index], named[index + 1]]);
  return moves;
}

/**
 * What to re-check for this change, or null for nothing.
 *
 * A one-note move also says who could see the note where it was, from the
 * tool's own `source_visibility` — read from the manifest before the move,
 * which then carried any exception along with the note. A device catching up
 * is told the old path left only by that ("What changed since"),
 * and the Convex tree's gone row narrows to it (`reportTreeTouch` carries it,
 * `lib/nodes/convexTable.ts`): the move cleared the source's exception before
 * the tree is re-checked, so the rules alone would name it to the folder.
 */
export function treeTouchOf(action, paths, details) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const named = paths.filter((path) => typeof path === "string");
  if (named.length === 0) return null;
  if (sendsTreeHint(action, details)) {
    const pairs = movesOf(action, named, details);
    const moves = pairs.length > 0 ? { moves: pairs } : {};
    // Carried as a flag rather than a path: the tree re-checks what the
    // change named, and only the control plane's mirror needs the manifest.
    const privacy = PRIVACY_WRITERS.has(action) ? { privacy: true } : {};
    const visibility = details?.source_visibility;
    if (!ONE_NOTE_MOVES.has(action) || named.length !== 2 || typeof visibility !== "string") {
      return { paths: named, ...moves, ...privacy };
    }
    const audiences = ["private"];
    if (visibility === "team" || GROUP_SCOPE_PATTERN.test(visibility)) audiences.push(visibility);
    return { paths: named, left: [{ path: named[0], audiences }], ...moves, ...privacy };
  }
  if (WRITES.has(action)) return { files: named };
  return null;
}

/**
 * The notes a text-only save changed, for the Convex tree's gathered re-check,
 * or none. A save that `treeTouchOf` already re-checks (front matter changed)
 * is not named twice.
 */
export function treeEditsOf(action, paths, details) {
  if (!TEXT_SAVES.has(action) || !Array.isArray(paths)) return [];
  if (treeTouchOf(action, paths, details) !== null) return [];
  return paths.filter((path) => typeof path === "string" && path !== "");
}
