/**
 * Two people on one canvas: what to send, and what to do with what arrives.
 *
 * ## A drawing is not collaboratively edited text
 *
 * A `.excalidraw.md` file is Markdown wrapped around one enormous compressed
 * payload. Merging two people's edits by merging that file character by
 * character produces a payload that is neither person's drawing and very
 * likely nobody's — a corrupt scene, from a merge that "succeeded". So the
 * unit that travels is the **element**: a rectangle, an arrow, a label. Notes
 * merge as text because text is what they are; drawings merge as elements for
 * the same reason.
 *
 * ## Excalidraw already knows how to reconcile, and we use its answer
 *
 * Every element carries `version` (how many times it has changed) and
 * `versionNonce` (a random tiebreak), and Excalidraw ships
 * `reconcileElements(local, remote, appState)` built on them — the same
 * function its own collaborative editor uses, including the fractional `index`
 * that decides z-order. Reimplementing that would be reimplementing a
 * published, tested answer badly.
 *
 * This module therefore does *not* merge. It answers the two questions that
 * sit either side of the merge and are ours rather than Excalidraw's: which
 * elements are worth putting on the wire, and how a set of elements is encoded
 * for a channel that carries opaque base64. The reconciliation happens in the
 * editor page, where Excalidraw is.
 *
 * ## Deletion is an element update, which is why this is simple
 *
 * Excalidraw does not remove a deleted element; it sets `isDeleted` and bumps
 * `version`. So "somebody deleted the shape I was resizing" is an ordinary
 * version race with an ordinary answer, and there are no tombstones to keep,
 * no deletes to order against edits, and nothing that needs a CRDT here.
 *
 * Zero dependencies, like everything else in this package, because the gateway
 * imports from it by relative path.
 */

/**
 * The elements worth broadcasting: everything new or changed since last time.
 *
 * Excalidraw's `onChange` fires continuously while somebody drags — on a
 * hundred-element selection, that is a hundred elements reported on every
 * frame of the drag. Sending all of them every time is the difference between
 * a canvas that keeps up and one that does not, and it is also what would fill
 * the room's log with a thousand copies of the same rectangle.
 *
 * `seen` is a map of element id to the version last sent, and it is **not**
 * mutated here: a caller that fails to send must not have recorded that it
 * did. `remember` is the other half, called once the send succeeds.
 *
 * A version that went *backwards* still counts as changed. That happens after
 * an undo, and a peer holding the higher version will simply win the
 * reconciliation — which is the correct outcome and not this function's
 * decision to make.
 */
export function changedElements(elements, seen) {
  const out = [];
  for (const element of elements) {
    if (!element || typeof element.id !== "string") continue;
    const version = typeof element.version === "number" ? element.version : 0;
    const nonce = typeof element.versionNonce === "number" ? element.versionNonce : 0;
    const previous = seen.get(element.id);
    if (previous && previous.version === version && previous.nonce === nonce) continue;
    out.push(element);
  }
  return out;
}

/** Record what `changedElements` returned, once it has actually gone out. */
export function remember(elements, seen) {
  for (const element of elements) {
    if (!element || typeof element.id !== "string") continue;
    seen.set(element.id, {
      version: typeof element.version === "number" ? element.version : 0,
      nonce: typeof element.versionNonce === "number" ? element.versionNonce : 0,
    });
  }
  return seen;
}

/**
 * Whether an object could be an Excalidraw element that arrived from a peer.
 *
 * Deliberately shallow: this is not a schema check and must not become one —
 * Excalidraw's element shape changes between versions, and a validator that
 * knew it would start rejecting valid drawings on the next bump. What is
 * checked is what the code downstream actually dereferences, plus the two
 * fields reconciliation decides by. Everything else is Excalidraw's business
 * and is passed through untouched.
 */
export function looksLikeElement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.type !== "string" || value.type.length === 0) return false;
  if (value.version !== undefined && typeof value.version !== "number") return false;
  if (value.versionNonce !== undefined && typeof value.versionNonce !== "number") return false;
  return true;
}

/**
 * Elements to base64, for a channel that carries opaque base64 either way.
 *
 * UTF-8 through `TextEncoder` rather than `btoa(JSON.stringify(...))`: a label
 * with an emoji or an accent in it throws out of `btoa`, and a drawing whose
 * text is not ASCII is an ordinary drawing.
 */
export function encodeElements(elements) {
  const bytes = new TextEncoder().encode(JSON.stringify(elements));
  let binary = "";
  // In chunks: `String.fromCharCode(...bytes)` on a large scene overflows the
  // argument limit, which is a crash on exactly the drawings that need this
  // most.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Base64 back to elements, refusing anything that is not a list of them.
 *
 * Returns `[]` rather than throwing, and drops individual entries that do not
 * look like elements rather than the whole frame — a peer that sends one bad
 * element should cost that element, not everything else in the same message.
 */
export function decodeElements(payload) {
  let json;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
  if (!Array.isArray(json)) return [];
  return json.filter(looksLikeElement);
}

/**
 * Where a tool's write landed on the canvas, so its cursor can be drawn there.
 *
 * ## Why this is not a diff
 *
 * A person drawing sends the elements they changed, because their editor knows
 * which ones those are. A tool writes a whole `.excalidraw.md` — the only
 * shape `write_note` has — so what arrives is the entire scene, and the
 * console that merges it deliberately holds no second copy to compare against:
 * it is a relay for drawings, and the scene lives in the editor page.
 *
 * So the position comes out of the elements themselves. `updated` is
 * Excalidraw's own record of when an element last changed, which is exactly
 * the question, and `version` — how many times it has *ever* changed — is only
 * the tiebreak. Ranking by `version` instead was the first version of this and
 * it points at the shape somebody has been fiddling with all afternoon rather
 * than the one the tool just drew.
 *
 * ## `null` is a real answer
 *
 * An element hand-authored by a tool that never went through Excalidraw has no
 * `updated`, and a scene of those has no honest position in it. Returning the
 * origin would put a tool's cursor in the top-left corner of somebody's canvas
 * and claim it is working there. The caller draws nothing instead — the same
 * rule a peer's missing pointer already follows.
 *
 * Deleted elements count. Excalidraw deletes by flag, so the element a tool
 * just removed is both the most recently changed thing in the scene and
 * exactly where the tool was.
 */
export function latestChangePoint(elements) {
  let best = null;
  for (const element of elements) {
    if (!looksLikeElement(element)) continue;
    if (typeof element.updated !== "number" || !Number.isFinite(element.updated)) continue;
    const version = typeof element.version === "number" ? element.version : 0;
    if (best && (element.updated < best.updated || (element.updated === best.updated && version <= best.version))) {
      continue;
    }
    best = { element, updated: element.updated, version };
  }
  if (!best) return null;

  const { x, y, width, height } = best.element;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // The middle of the shape, or its corner when it has no size — a line and a
  // freedraw stroke both report dimensions, but not every element type does,
  // and half of `undefined` is `NaN` rather than a position.
  const w = Number.isFinite(width) ? width : 0;
  const h = Number.isFinite(height) ? height : 0;
  return { x: x + w / 2, y: y + h / 2 };
}
