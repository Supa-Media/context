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
 * Every outcome is handed in rather than handed back, for the same reason: a
 * caller that can branch is a caller that can branch wrongly.
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
 *
 * ## The other half: everybody else has to see it too
 *
 * The room hands a tool's write to **one** member, because the same text
 * merged into N copies of a shared document inserts it N times. For a note
 * that is the whole story — the merge is an edit like any other and travels to
 * every peer down the ordinary update path, so all this client owes the room
 * afterwards is **where the tool left its caret**.
 *
 * A canvas has no such path. Elements handed to this browser's Excalidraw go
 * nowhere else, so a second person watching the same drawing saw the tool's
 * version arrive and none of its shapes — the drawing equivalent of the defect
 * above, one room over. So the merger **re-broadcasts** what it was given: the
 * unit that travels is the element, reconciliation is by version, and applying
 * the same element twice is the same drawing. That is what makes a re-broadcast
 * safe here and would not make a re-broadcast of text safe there.
 */

import { latestChangePoint, parseDrawing } from "@context/drawings";
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

/**
 * Everything this client does with a write, each handed in separately.
 *
 * Separate rather than one "result" object because they are not one decision:
 * a canvas delivers, re-shares, points and adopts, and a note merges, reports
 * a caret and adopts. Collapsing them into a return value would put the
 * question of *which of those happened* back in the caller, which is where the
 * two defects in the header came from.
 */
export interface ExternalWriteSinks {
  /** Put the tool's elements on this browser's canvas. */
  deliverElements: (elements: unknown[]) => void;
  /** Put the same elements on the wire, so every other client sees them. */
  shareElements: (elements: unknown[]) => void;
  /**
   * Where the tool's caret goes in the note, as offsets in the merged text.
   *
   * Not called when the write changed nothing: an identical file is not an
   * edit, and a caret is a claim that somebody is working at a position.
   */
  reportCaret: (span: { from: number; to: number }) => void;
  /** Where the tool's pointer goes on the canvas, in scene coordinates. */
  reportPointer: (at: { x: number; y: number }) => void;
  /** Take the write's version. Only ever called when the content arrived. */
  adopt: () => void;
}

export function applyExternalWrite(write: ExternalWrite, sinks: ExternalWriteSinks): void {
  if (write.shared) {
    let span: { from: number; to: number } | null;
    try {
      span = mergeExternalText(write.shared, write.text);
    } catch {
      // The document is as it was, so this client does not hold the text.
      return;
    }
    // The caret before the version, because the caret is what somebody is
    // watching for and the version is bookkeeping. Order is not load-bearing;
    // being explicit about it is, since one of these two is reported for the
    // agent and the other for this client.
    if (span) sinks.reportCaret(span);
    sinks.adopt();
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

  sinks.deliverElements(elements);
  // Everybody else's canvas, which nothing else in this room will do for them.
  sinks.shareElements(elements);
  /*
    And where the tool was working, when the scene says. `latestChangePoint`
    returns `null` for a scene whose elements carry no `updated` — a tool that
    hand-wrote a file rather than going through Excalidraw — and no pointer is
    the right answer there. It is deliberately not a reason to withhold the
    version: the shapes arrived, which is the whole test for adoption.
  */
  const at = latestChangePoint(elements);
  if (at) sinks.reportPointer(at);
  sinks.adopt();
}
