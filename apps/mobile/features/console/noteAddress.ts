/**
 * Keeping the URL and the open note saying the same thing.
 *
 * ## The bug
 *
 * `/console/@seyi?note=…` opened the note it named — `useLinkedNote` did that
 * half and did it correctly — and **nothing ever wrote the URL back**. So the
 * address bar told the truth for exactly as long as it took somebody to tap a
 * second note, and every refresh after that dropped them on "Choose a note to
 * read or edit it" over the context they were already in. Reload, hard reload,
 * bookmark, copy the URL out of the bar and send it: all four gave a link to a
 * *context*, from somebody who was looking at a *note*.
 *
 * That is the whole of the web half of file-page persistence, and the fix is
 * not a store: it is making the URL a mirror of the selection rather than a
 * one-shot instruction to it. Nothing is saved anywhere on web, which is the
 * point — a URL is already durable, already shareable, already survives a
 * process restart, and already has a Back button attached.
 *
 * ## Why this is a pure function
 *
 * Because it is a **two-way** sync, and two-way syncs oscillate. The failure
 * mode is not a wrong pixel, it is an infinite loop between two effects that
 * each undo the other, and neither the router nor the file browser can be
 * mounted in this suite to find one. So the rule is a function from the two
 * values plus what was last reconciled to a single step, and
 * `__tests__/noteAddress.test.ts` drives it through the sequences that actually
 * happen — cold link, tap another note, follow a second link, delete the open
 * note — asserting that each settles.
 *
 * `useNoteAddress` is the thin hook around it; `__tests__/linkedNote.test.ts`
 * still drives that against the real `useFileBrowser`, because the *ordering*
 * problem it was written for is a fact about the reconciler and not about this
 * rule.
 *
 * ## Which side wins
 *
 * **A URL that changed wins.** Somebody followed a link, and a link that lands
 * on the note you already had open is a link that did not work.
 *
 * **Otherwise the selection wins**, including when the URL *lost* its note. A
 * console URL with no note, over a console with a note open, is stale rather
 * than an instruction: there is no "close the note" for it to be expressing —
 * `select` takes a path and the file browser has no deselect — so treating it
 * as one would leave the address bar disagreeing with the screen, which is the
 * state this module exists to end. It is re-addressed instead.
 */

/** What was reconciled last, for the context it was reconciled in. */
export interface Reconciled {
  contextId: string;
  note: string | null;
  selected: string | null;
}

export interface AddressInputs {
  /**
   * The context the **file browser** has caught up with.
   *
   * Not the one the console has chosen. The two differ for one commit on a
   * cold load, and acting in that commit is how a linked note used to be
   * cleared microseconds after being opened — `useLinkedNote`'s comment and
   * `browser.ts`'s `contextId` both carry the full account.
   */
  contextId: string | null;
  /** The context the console has chosen. */
  selectedContextId: string | null;
  /** What the URL asks for: `?note=`, already validated by `noteFromQuery`. */
  note: string | null;
  /** What the file browser has open — a note or a folder, or nothing. */
  selected: string | null;
  seen: Reconciled | null;
}

export type AddressStep =
  /** The browser is not on this context yet. Do nothing, record nothing. */
  | { action: "wait" }
  /** The URL named a note. Open it. */
  | { action: "open"; path: string }
  /** The selection moved. Put it in the URL — `null` clears `?note=`. */
  | { action: "address"; note: string | null }
  /** They already agree. */
  | { action: "hold" };

export function nextAddressStep(inputs: AddressInputs): AddressStep {
  const { contextId, selectedContextId, note, selected, seen } = inputs;
  if (selectedContextId === null) return { action: "wait" };
  if (contextId !== selectedContextId) return { action: "wait" };

  if (note === selected) return { action: "hold" };

  /*
    A context this rule has not reconciled yet — a cold load, or the first
    commit after switching contexts. The URL is the instruction: it is the only
    thing that survived getting here, and the selection is empty by
    construction (the browser clears it when the workspace changes).
  */
  const fresh = seen === null || seen.contextId !== contextId;
  if (fresh) {
    return note === null ? { action: "address", note: selected } : { action: "open", path: note };
  }

  // A URL that changed is somebody following a link, and it wins. A URL that
  // lost its note is stale rather than a request; see the module comment.
  if (note !== seen.note && note !== null) return { action: "open", path: note };
  return { action: "address", note: selected };
}
