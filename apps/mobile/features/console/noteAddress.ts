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
 * **A URL that lost its note wins too**, and closes the note. That is the half
 * of this rule that was wrong for as long as `FileBrowser` had no inverse of
 * `select`: with no "close the note" to express, such a URL was read as stale
 * and re-addressed. The reasoning was right about the mechanism and the cost
 * was a dead control — the phone's lit context pill navigates to
 * `/console/@slug` with no note, because that is what "open its root" *is*, and
 * the mirror put the note straight back before anybody saw the root. Pressing
 * the one thing on the screen labelled as the way up did nothing.
 *
 * `deselect` exists now, so the rule is symmetric: **a URL that changed is a
 * navigation**, honoured whichever way it went. A URL that did *not* change is
 * not one, which is the distinction doing the work — somebody tapping a note at
 * `/console/@seyi` produces a commit where `note` is `null` and the selection
 * has moved, and reading that as a close would shut every note one commit after
 * it opened. The `seen` pair is what tells the two apart, and it is the same
 * pair that already told a followed link from an echo of the last one.
 *
 * A refused close leaves the note open, and `useNoteAddress` puts the address
 * back on it rather than leaving the two disagreeing — which a refused `select`
 * deliberately does not get. That asymmetry is a real one and the reason is
 * there.
 *
 * **Otherwise the selection wins.**
 *
 * ## …and neither side wins across a context switch
 *
 * "I'll change between workspaces and it will say file not found." The rule
 * above is right about a stale URL and was reading one that was not stale at
 * all: a URL is a **context and a note**, and this took the note from the URL
 * and the context from the console's state. Those disagree for the commits
 * between the rail replacing the address and the layout selecting the context
 * it names — so the URL's absent note was compared against the *previous*
 * context's open one, found to be missing, and "fixed" by writing that note
 * onto the new context's address. `?note=` then named a path that context has
 * never had, the browser opened it as a link, and the person got "That file
 * does not exist" for pressing a workspace.
 *
 * On a phone the same commit is worse than a wrong address: its strip carries
 * the note the *new* context was last left at, so the rule would `select` that
 * path while the browser is still pointed at the old workspace — one context's
 * path read against another's bucket.
 *
 * So `urlContextId` is an input, and nothing is reconciled until the URL, the
 * console and the file browser all name the same context. A deep link into
 * another context is unaffected, because it is not a switch: the URL names
 * `@supa` from the first commit, and the note is opened as soon as the console
 * catches up with it — which is the sequence `linkedNote.test.ts` has always
 * driven.
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
  /**
   * The context **the URL itself names**, resolved against the context list —
   * `null` for a slug that is not in it (still loading, or a dead link).
   *
   * The half of the URL that used to be missing here, and the whole of the
   * switch bug. A console URL is one fact — a context *and* a note — and this
   * rule read the note out of it while taking the context from the console's
   * own state, which lags the URL by a commit or two on every switch. Pairing
   * `@supa`'s (absent) note with `@seyi`'s open one is what made the rule
   * conclude the URL had gone stale and write the old note back onto the new
   * context's address. See `nextAddressStep`.
   */
  urlContextId: string | null;
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
  /**
   * The URL dropped its note. Close the open one and stand at the root.
   *
   * Carries no path: there is exactly one thing open and the browser knows
   * which. Passing one would invite a caller to close something else.
   */
  | { action: "close" }
  /** They already agree. */
  | { action: "hold" };

export function nextAddressStep(inputs: AddressInputs): AddressStep {
  const { contextId, selectedContextId, urlContextId, note, selected, seen } = inputs;
  if (selectedContextId === null) return { action: "wait" };
  if (contextId !== selectedContextId) return { action: "wait" };
  /*
    ...and the URL is talking about this context too.

    Switching context moves the URL first: the rail replaces it with
    `/console/@supa`, the phone's strip with `/console/@supa?note=<that
    context's own path>`, and only then does the layout's effect select the new
    context and the browser reset under it. For those commits every value in
    hand is honest and the *pair* is not: the note comes from the new address
    and the selection belongs to the old context, which is precisely the pair
    this rule may not reconcile. Acting on it wrote one context's note into the
    other's address bar, and the console then opened it as a link into a
    context that has never had that file.
  */
  if (urlContextId !== contextId) return { action: "wait" };

  if (note === selected) return { action: "hold" };

  /*
    A context this rule has not reconciled yet — a cold load, the first
    commit after switching contexts, or a route that remounted under a
    browser that did not. The URL is the instruction: it is the only thing
    that survived getting here.

    **`selected` is empty by construction only for the first two.**
    `useFileBrowser` clears `selectedPath` in the very same commit it adopts
    a new `contextId` (its context-reset effect sets both), so a genuinely
    fresh instance's first non-`wait` commit always pairs "the URL has
    nothing" with "neither does the browser" — and that pair is `hold`,
    above, before this line ever runs. So reaching here with `note === null`
    means `selected` cannot be `null` too (ruled out by the same `hold`) and
    cannot be a value *this* instance produced (it has produced nothing yet):
    it is the browser's, surviving from before `seen` was wiped.

    That is exactly what a route remount looks like from in here.
    `ConsoleDataProvider` and `FileBrowser` live above the route and do not
    remount with it, so `files.selectedPath` is still whatever was open while
    this hook's own `seen` ref resets to `null`. The shipped fix for "the lit
    pill does nothing" first read as `router.replace(browseHref(slug))`,
    which is a `REPLACE` action — and `StackRouter` mints a fresh route key
    for every `REPLACE` regardless of whether the params it carries actually
    differ, remounting the very hook trying to close the note. Answering
    `address` here re-opened the note it was told to close. The call site is
    fixed (`_layout.tsx` deselects directly and never asks the router to
    revisit this route), but the rule itself no longer trusts an assumption
    its own caller once violated: whatever remounted it, the URL's silence is
    still the instruction, and a leftover selection is answered by closing it
    rather than by re-minting an address for it. See
    `docs/decisions/app-and-console.md`, "the first fix did not hold".
  */
  const fresh = seen === null || seen.contextId !== contextId;
  if (fresh) {
    if (note === null) return { action: "close" };
    return { action: "open", path: note };
  }

  /*
    A URL that changed is a navigation, and it wins — a link followed if it
    names a note, a move to the context's root if it names none. A URL that did
    **not** change is not a navigation, whatever it says: the selection moved
    under it and the address is what has to catch up.
  */
  if (note !== seen.note) {
    return note === null ? { action: "close" } : { action: "open", path: note };
  }
  return { action: "address", note: selected };
}
