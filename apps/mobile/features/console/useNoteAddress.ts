import { useEffect, useRef } from "react";
import type { FileBrowser } from "./files/browser";
import { nextAddressStep, type Reconciled } from "./noteAddress";

/**
 * Keep `?note=` and the open note saying the same thing, in both directions.
 *
 * This replaced `useLinkedNote`, which did the URL→selection half — a link
 * opened the note it named — and nothing did the other one. See
 * `noteAddress.ts` for what that cost and for the rule itself, which is a pure
 * function so that a two-way sync's real failure mode (two effects undoing each
 * other forever) can be tested without a router.
 *
 * ## Why the two halves are one hook and not two
 *
 * Because two hooks reading each other's output through the router is the
 * oscillation. Concretely, with a separate "write the selection into the URL"
 * hook beside the old one: tapping note B sets `?note=B`, the link hook sees a
 * `note` it has not applied yet, and calls `select("B")` on the note that is
 * already open. `select` is **not** idempotent — it dispatches a fresh
 * `readNote` — so every tap would cost a second round trip for the same note,
 * and every one of them would be indistinguishable from a link being followed.
 *
 * ## Why the reconciled pair is recorded before acting, not after
 *
 * Both actions cause the re-render that runs this effect again, and the values
 * it will see then are the ones being recorded now. Recording afterwards would
 * mean recording what the *action* produced, which is exactly the state the
 * next pass has to be able to tell apart from a fresh instruction.
 *
 * It is also why a refused `select` settles rather than looping. The unsaved-
 * changes guard answers `false` and leaves the selection where it was; the next
 * pass sees a `note` it has already reconciled and a selection that disagrees,
 * and addresses the *open* note. The URL then follows what is on screen, which
 * is the honest answer while a prompt is asking whether to discard a draft.
 *
 * `deselect` is refused by the same guard and does **not** settle by the same
 * route — see the `close` branch below for which failure that is and why it is
 * answered where a refused `select` is left alone.
 */
export function useNoteAddress(
  files: FileBrowser,
  /**
   * What the URL says, both halves of it.
   *
   * A context and a note, taken from the same address in the same commit.
   * Passing only the note — which is what this took — let the rule pair it
   * with the console's own context, which lags the URL across a switch. See
   * `noteAddress.ts`.
   */
  url: {
    /** The context the URL names, resolved against the list. */
    contextId: string | null;
    /** `?note=`, already validated by `noteFromQuery`. */
    note: string | null;
  },
  selectedContextId: string | null,
  /** Write the URL. `null` clears `?note=` rather than naming an empty note. */
  address: (note: string | null) => void,
): void {
  const seen = useRef<Reconciled | null>(null);
  const { select, deselect, contextId, selectedPath } = files;
  const { contextId: urlContextId, note } = url;

  /*
    Held in a ref and read inside the effect, so a caller that rebuilds the
    callback every render — the route does, it closes over `router` and `slug`
    — does not re-run this. A re-run is not merely wasted work here: it is a
    second pass over a rule whose whole job is to act once per change.
  */
  const addressRef = useRef(address);
  addressRef.current = address;

  useEffect(() => {
    const step = nextAddressStep({
      contextId,
      selectedContextId,
      urlContextId,
      note,
      selected: selectedPath,
      seen: seen.current,
    });
    if (step.action === "wait") return;

    // `contextId === selectedContextId` and that is not null, or the step
    // above was `wait`.
    seen.current = { contextId: contextId!, note, selected: selectedPath };

    if (step.action === "open") select(step.path);
    /*
      The URL went to the context's root, so close what is open.

      **A refusal is put back into the URL here, and a refused `select` is
      not** — which looks inconsistent and is the difference between the two
      failures. A refused `select` leaves `?note=` naming the note somebody was
      *going to*: the screen and the address disagree, and a reload opens that
      note, which is where they were headed anyway. A refused close leaves the
      address at the context's root while a conflicted note is still open and
      unanswered — and the phone writes that address to the device
      (`useRememberPlace`), so the relaunch after it would come back to the root
      with the conflict gone from the screen and the draft still unresolved in
      the outbox.

      So the guard's `false` is answered immediately: the address returns to the
      note that is still on screen, which settles on the next pass (`note ===
      selected` is a `hold`) and keeps the device record pointing at the thing
      that needs an answer.
    */
    else if (step.action === "close" && !deselect()) addressRef.current(selectedPath);
    else if (step.action === "address") addressRef.current(step.note);
  }, [contextId, deselect, note, select, selectedContextId, selectedPath, urlContextId]);
}
