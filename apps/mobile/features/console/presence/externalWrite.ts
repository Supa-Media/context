/**
 * What a tool's write does to the client the room asked to merge it.
 *
 * ## The version and the content are one fact
 *
 * A console save is a conditional write: it sends the etag the editor is
 * holding, and the bucket refuses it if somebody has written since. **That
 * refusal is the only thing between a stale draft and a silent overwrite**, and
 * moving the editor's etag is what spends it. So the version of a write may
 * only be adopted by a client that has **received what the write contained**.
 *
 * That rule is why this file exists rather than an `if` in the socket handler.
 * Two defects have already come out of the gap between those two halves — a
 * canvas that adopted a version and showed none of it, and a version broadcast
 * to members who were never given the text — and both lived in a branch no
 * test reaches. `docs/decisions/testing.md` says plainly that CI does not cover
 * the socket, so a decision left there is a decision nobody checks.
 *
 * `adopt` is handed in rather than the answer handed back, for the same
 * reason: a caller that can branch is a caller that can branch wrongly.
 *
 * ## Two ways a write arrives, and each can fail to
 *
 *  - **A note** merges as text into the shared document, and every editor
 *    bound to it follows. A merge that throws leaves the document exactly as
 *    it was, so this client does *not* hold the tool's text.
 *  - **A canvas** has no shared document — a drawing merges as elements — so
 *    the file is parsed back into elements and handed on like a peer's change.
 *    A payload that will not parse, or one carrying no elements at all,
 *    delivers nothing.
 *
 * In every one of those failures the bucket still holds the tool's write. What
 * must not happen is this client claiming its version: the next save would
 * pass its conditional check and put older content over it, with nobody shown
 * a conflict. Keeping the old etag costs one conflict and asks somebody.
 */

import { parseDrawing } from "@context/drawings";
import { mergeExternalText, type SharedDoc } from "./sharedDoc";

export interface ExternalWrite {
  /** What the tool wrote, as the file it wrote. */
  text: string;
  /** The note it wrote, which is what tells a drawing how to parse. */
  path: string;
  /** The shared document, or `null` in a room that merges elements. */
  shared: SharedDoc | null;
  /** Whether this room is a canvas. */
  drawing: boolean;
}

export function applyExternalWrite(
  write: ExternalWrite,
  deliverElements: (elements: unknown[]) => void,
  adopt: () => void,
): void {
  if (write.shared) {
    try {
      mergeExternalText(write.shared, write.text);
    } catch {
      // The document is as it was, so this client does not hold the text.
      return;
    }
    adopt();
    return;
  }

  // Not a canvas and no document: nothing here can receive the write at all.
  if (!write.drawing) return;

  /*
    `parseDrawing` reports rather than throws — a payload it cannot read comes
    back as `unreadable` with `elements: null`, for all three of its reasons
    (no payload, undecodable, unrecognised). So there is no `try` here: a
    `catch` around a function that does not throw is a guard nobody can check,
    and the case it was there for arrives through the line below instead.

    No elements is not a delivery. A *cleared* canvas is not this either:
    Excalidraw deletes by flag, so a real clear arrives as elements carrying
    `isDeleted`, which is a scene with things in it.
  */
  const elements = (parseDrawing(write.text, write.path).elements ?? []) as unknown[];
  if (elements.length === 0) return;

  deliverElements(elements);
  adopt();
}
