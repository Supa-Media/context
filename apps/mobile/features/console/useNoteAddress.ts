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
 */
export function useNoteAddress(
  files: FileBrowser,
  note: string | null,
  selectedContextId: string | null,
  /** Write the URL. `null` clears `?note=` rather than naming an empty note. */
  address: (note: string | null) => void,
): void {
  const seen = useRef<Reconciled | null>(null);
  const { select, contextId, selectedPath } = files;

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
      note,
      selected: selectedPath,
      seen: seen.current,
    });
    if (step.action === "wait") return;

    // `contextId === selectedContextId` and that is not null, or the step
    // above was `wait`.
    seen.current = { contextId: contextId!, note, selected: selectedPath };

    if (step.action === "open") select(step.path);
    else if (step.action === "address") addressRef.current(step.note);
  }, [contextId, note, select, selectedContextId, selectedPath]);
}
