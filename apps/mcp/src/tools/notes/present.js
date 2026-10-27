/**
 * Whether the note `write_note` is about to write already exists, asked of the
 * Convex tree, never the bucket: names come only from the tree, and the bucket
 * is opened only for a note's body (owner, 2026-10-14). The note is opened
 * only where it exists, because then this write is an edit and needs its text
 * and etag.
 *
 * A caller that passed `expected_etag` read the note and is editing it, so
 * the note is opened without asking.
 *
 * The tree is a second or two behind this gateway's own writes
 * (`tree/names.js`). A create is always written `onlyIf: { absent: true }`,
 * so a note the tree has not heard of yet is never overwritten as if new: the
 * write is refused as a create that lost a race, exactly as when two writers
 * create one name at once, and the caller re-reads and writes again with the
 * etag it read. A store with no control
 * plane has no tree to ask, so `takenInTree` refuses the write.
 */

import { getWithLegacyFallback } from "../../storageLayout.js";
import { takenInTree } from "../../tree/names.js";
import { TreeUnavailable } from "../../tree/served.js";

/**
 * `{ exists }` from the tree, or `{ exists, object }` where the note was opened
 * (an edit, or a store with no tree), or `{ refusal }` when the tree cannot
 * say: a write is not made on a guess.
 *
 * Only whether it exists, not the note itself: `write_note` opens it after
 * every permission check, so a refused write costs the same whether or not
 * anything is there (`privacyGroups.test.mjs`, "costs what one refused by a
 * folder rule costs").
 *
 * @param {object} store
 * @param {string} path
 * @param {{ editing: boolean }} how `editing` when the caller is known to be editing
 */
export async function noteBeingWritten(store, path, { editing }) {
  if (editing) {
    const object = await getWithLegacyFallback(store, path);
    return { exists: object !== null && object !== undefined, object: object ?? null };
  }
  let taken;
  try {
    taken = await takenInTree(store, [path]);
  } catch (error) {
    if (error instanceof TreeUnavailable) return { refusal: error.message };
    throw error;
  }
  return { exists: taken.files.has(path) };
}

/** The note `noteBeingWritten` found, opened now that the write may go ahead. */
export async function openNoteBeingWritten(store, path, found) {
  if (found.object !== undefined) return found.object;
  return found.exists ? await getWithLegacyFallback(store, path) : null;
}
