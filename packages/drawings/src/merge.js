/**
 * Two saves of one drawing, made at once, combined instead of refused.
 *
 * ## Why a save needs this when the canvas already merges
 *
 * Two people on one canvas see each other's shapes live: the room carries
 * elements and the editor page reconciles them with Excalidraw's own
 * `reconcileElements` (`collab.js`). But each of them still *saves* the file,
 * with a conditional write against the version they last read, and a canvas
 * fires a change on every stroke. Two people drawing therefore race to the
 * bucket every couple of seconds, and the loser's write is refused as a
 * conflict — which put the "changed in your bucket while you were editing it"
 * page in front of somebody whose canvas already held both people's work.
 *
 * Text notes never hit that page because their shared saving merges. A drawing
 * merges as elements, so this is the file-level twin of the canvas's reconcile:
 * read the version that won, combine its elements with this person's, splice
 * the result into the winner's bytes, and write again against its etag.
 *
 * ## The rule is Excalidraw's, restated because Excalidraw is not here
 *
 * The save path runs in the console, which deliberately does not load the
 * 2.4MB editor. So the per-element rule `reconcileElements` applies is
 * restated: for each id the higher `version` wins, and at an equal version the
 * lower `versionNonce` wins. Both sides reach the same answer whichever of them
 * merges, and the canvas reaches it too. A deletion is an element at a higher
 * version with `isDeleted` set, so "I deleted what you moved" is an ordinary
 * version race — which is why the scenes are read with deleted elements kept.
 *
 * Zero dependencies, like the rest of this package.
 */

import { readDrawingScene, serializeDrawing } from "./serialize.js";

function versionOf(element) {
  return typeof element.version === "number" ? element.version : 0;
}

function nonceOf(element) {
  return typeof element.versionNonce === "number" ? element.versionNonce : 0;
}

/** Does `candidate` replace `held` for the same id? */
function wins(candidate, held) {
  const a = versionOf(candidate);
  const b = versionOf(held);
  if (a !== b) return a > b;
  return nonceOf(candidate) < nonceOf(held);
}

/**
 * One list of elements from two, one element per id.
 *
 * Order: the fractional `index` Excalidraw stores when every element carries
 * one (that is the z-order, and both sides agree on it); otherwise theirs, in
 * their order, with elements only this side has after them in this side's
 * order. Elements with no string id are kept from both sides as they are.
 */
export function mergeElements(mine, theirs) {
  const byId = new Map();
  const order = [];
  const loose = [];
  for (const list of [theirs, mine]) {
    for (const element of list) {
      if (!element || typeof element !== "object") continue;
      if (typeof element.id !== "string") {
        loose.push(element);
        continue;
      }
      const held = byId.get(element.id);
      if (held === undefined) {
        byId.set(element.id, element);
        order.push(element.id);
      } else if (wins(element, held)) {
        byId.set(element.id, element);
      }
    }
  }
  const merged = order.map((id) => byId.get(id));
  if (merged.length > 0 && merged.every((element) => typeof element.index === "string")) {
    merged.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return [...merged, ...loose];
}

/**
 * The file body that holds both people's drawing, or null.
 *
 * Spliced into `theirs` — the version in the bucket, which the write that
 * follows is conditional on — so whatever else that version carries (front
 * matter, links, a section this package has never heard of) is kept as it is.
 * Embedded images are the union, this side's copy of an id winning, since an
 * image id names one picture. Null when either side is not a drawing this can
 * splice, and the caller then shows the conflict as before.
 */
export function mergeDrawings(mine, theirs) {
  const own = readDrawingScene(mine);
  const other = readDrawingScene(theirs);
  if (!own || !other || !Array.isArray(own.elements) || !Array.isArray(other.elements)) return null;
  const elements = mergeElements(own.elements, other.elements);
  const files = { ...(isRecord(other.files) ? other.files : {}), ...(isRecord(own.files) ? own.files : {}) };
  return serializeDrawing(theirs, elements, Object.keys(files).length > 0 ? { files } : {});
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
