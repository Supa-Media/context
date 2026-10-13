/**
 * Which recorded changes re-check the tree table, and how.
 *
 * `recordChange` is the one call every gateway write makes afterwards, so it
 * is where the table hears about them. A change to the tree's shape — a note
 * created, moved, archived, a folder moved — has every path it names
 * re-checked as a note and as a folder (`touchTree`). A write that only puts
 * text in a note has that key alone re-checked, except a save of an existing
 * note's body (`update_note`), whose new version reaches the table inside the
 * search projection's own database call (`writeProjection.js`) instead: the
 * live editor commits every typing pause, and a listing per pause is cost with
 * nothing to show for it.
 */

import { createD1Client } from "../search/d1/client.js";
import { sendsTreeHint } from "../activity/changes.js";
import { touchTree } from "./touch.js";
import { canSee, GROUP_SCOPE_PATTERN } from "../privacy/engine.js";
import { loadPrivacyState } from "../privacy/state.js";
import { rescoreChange } from "../chaos/table.js";

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
 * of the tree's shape. The D1 table hears of them through the search
 * projection (`writeProjection.js`); the Convex tree hears of them as
 * `edited` (`treeEditsOf`), which the control plane gathers for a few seconds
 * before re-checking. Without it the Convex rows kept the version from the
 * last sweep (up to an hour), so the desktop and phone apps, which follow its
 * change log, never heard of an edit made on the web until then.
 */
const TEXT_SAVES = new Set(["update_note", "encrypt_note", "decrypt_note"]);

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
 * is told the old path left only by that (`table.js`, "What changed since").
 */
export function treeTouchOf(action, paths, details) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const named = paths.filter((path) => typeof path === "string");
  if (named.length === 0) return null;
  if (sendsTreeHint(action, details)) {
    const pairs = movesOf(action, named, details);
    const moves = pairs.length > 0 ? { moves: pairs } : {};
    // Carried as a flag rather than a path: the tree table re-checks what the
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

/** This context's database, or null where fast search has none. */
export function treeClientOf(store) {
  const descriptor = store?.searchIndex;
  if (!descriptor || typeof descriptor !== "object") return null;
  try {
    return createD1Client(descriptor);
  } catch {
    return null;
  }
}

/**
 * Re-check what a change touched, then rescore it for the chaos score.
 * Never throws: see `touchTree`.
 *
 * @returns {Promise<object | null>} what the change did to the chaos score (`chaos/table.js`), or null
 */
export async function keepTreeTable(store, touch) {
  if (!touch) return null;
  const client = treeClientOf(store);
  if (client === null) return null;
  try {
    await touchTree(store, client, touch);
  } catch {
    // A derivative one change behind; the next sweep repairs it.
  }
  return await keepChaos(store, client, touch);
}

/**
 * Rescore the folders a change touched (`chaos/table.js`). Never throws: a
 * score one change behind is put right by the next full pass.
 *
 * @param {object} store
 * @param {{ query: Function, runAll: Function } | null} [client] defaults to the store's database
 * @param {{ paths?: string[], files?: string[], moves?: [string, string][] }} touch
 */
export async function keepChaos(store, client, touch) {
  const database = client ?? treeClientOf(store);
  if (database === null || !touch) return null;
  try {
    const state = await loadPrivacyState(store);
    if (state.error) return null;
    const visibleToTeam = (path) => canSee(path, "team", state.rules, state.overrides);
    return await rescoreChange(database, { ...touch, visibleToTeam, store });
  } catch {
    return null;
  }
}
