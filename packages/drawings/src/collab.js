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
