/**
 * "Is that name taken?" and "how many notes are there?", asked of the Convex
 * tree for the gateway's writes (step 3 of the convex-only plan,
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * `move_note`, `archive_note` and `move_folder` used to GET every destination
 * before writing it, and the free plan's cap walked the bucket to count notes.
 * Nothing but opening and editing a note reads the bucket now (owner,
 * 2026-10-13), so they ask the control plane (`/gateway/tree/facts` with
 * `ask: "names"`, `apps/convex/functions/lib/nodes/gatewayNames.ts`), which
 * answers from the rows, through pending moves.
 *
 * **The tree can be a second or two behind this gateway's own writes**: a
 * write reports its touch after it answers (`activity/record.js`), and the
 * control plane re-checks it a moment later. So a name the tree calls free is
 * only an early answer, and every destination these tools write is written
 * `onlyIf: { absent: true }` (`moveSafetyRefusal` refuses a move on storage
 * that cannot hold that), which is the truth for a note written a second ago.
 * A name the tree calls taken is refused at once.
 *
 * Unfiltered names, for a writer only: a name taken by a note this grant
 * cannot see is taken, as it was over the bucket, and the tools decide what
 * to say with `canSee`.
 *
 * A store with no control plane has no tree to ask, so every name check is
 * refused there (`TreeUnavailable`, as `served.js` refuses every listing).
 */

import { TreeUnavailable } from "./served.js";

/** Names one ask may carry (`TAKEN_PATHS` in the control plane). */
const NAMES_PER_ASK = 100;

/**
 * Which of `paths` the tree draws a file at, and which a folder at. Throws
 * `TreeUnavailable` when the tree does not serve the workspace, when the
 * control plane cannot be asked, or when the store has no control plane.
 *
 * @param {object} store a session-bound store
 * @param {string[]} paths
 * @returns {Promise<{ files: Set<string>, folders: Set<string> }>}
 */
export async function takenInTree(store, paths) {
  const files = new Set();
  const folders = new Set();
  const unique = [...new Set(paths)];
  if (unique.length === 0) return { files, folders };
  if (typeof store?.treeFacts !== "function") {
    // Inside the Convex credential barrier the rows are read directly (`lib/nodes/treeNames.ts`).
    if (typeof store?.treeListing?.taken !== "function") throw new TreeUnavailable();
    for (let at = 0; at < unique.length; at += NAMES_PER_ASK) {
      const answer = await store.treeListing.taken(unique.slice(at, at + NAMES_PER_ASK));
      for (const path of answer.files) files.add(path);
      for (const path of answer.folders) folders.add(path);
    }
    return { files, folders };
  }
  for (let at = 0; at < unique.length; at += NAMES_PER_ASK) {
    let answer;
    try {
      answer = await store.treeFacts({ ask: "names", paths: unique.slice(at, at + NAMES_PER_ASK) });
    } catch {
      throw new TreeUnavailable();
    }
    if (!answer || answer.served !== true) throw new TreeUnavailable();
    if (!Array.isArray(answer.files) || !Array.isArray(answer.folders)) throw new TreeUnavailable();
    for (const path of answer.files) if (typeof path === "string") files.add(path);
    for (const path of answer.folders) if (typeof path === "string") folders.add(path);
  }
  return { files, folders };
}

/**
 * The note cap's count (`store/noteCap.js`), from the tree, or `null` where it
 * cannot answer; never throws.
 *
 * @param {(request: object) => Promise<object>} readFacts the control plane's facts route for this session
 * @returns {Promise<number|null>}
 */
export async function treeNoteCount(readFacts) {
  try {
    const answer = await readFacts({ ask: "names", count: true });
    return answer?.served === true && Number.isInteger(answer.notes) ? answer.notes : null;
  } catch {
    return null;
  }
}
