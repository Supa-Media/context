import { describe, expect, test } from "@jest/globals";
import {
  nextAddressStep,
  type AddressInputs,
  type Reconciled,
} from "../features/console/noteAddress";

/**
 * The URL and the open note are a two-way sync, and two-way syncs oscillate.
 *
 * `linkedNote.test.ts` proves the wiring settles against the real
 * `useFileBrowser`. This proves the *rule* — every sequence, including the ones
 * a mounted test would take a lot of `act`s to reach — by running it the way the
 * hook runs it: apply the step, feed the result back in, and require the loop to
 * reach `hold` in a bounded number of passes.
 *
 * That bound is the whole point. A rule that answers correctly once and never
 * settles is indistinguishable from a correct one in a single-step assertion,
 * and is a spinning phone in somebody's hand.
 */

const CTX = "w1";
const A = "1-projects/a.md";
const B = "2-areas/b.md";

/** One turn of the loop the hook runs: apply the step, record, feed it back. */
function settle(start: { note: string | null; selected: string | null }, passes = 8) {
  let { note, selected } = start;
  let seen: Reconciled | null = null;
  const writes: (string | null)[] = [];
  const opened: string[] = [];
  /** How many times the rule asked for the note to be closed. */
  let closed = 0;

  for (let pass = 0; pass < passes; pass += 1) {
    const inputs: AddressInputs = {
      contextId: CTX,
      selectedContextId: CTX,
      urlContextId: CTX,
      note,
      selected,
      seen,
    };
    const step = nextAddressStep(inputs);
    if (step.action === "wait") return { note, selected, writes, opened, closed, settled: false };
    // The hook records before acting; see `useNoteAddress` for why.
    seen = { contextId: CTX, note, selected };
    if (step.action === "hold") return { note, selected, writes, opened, closed, settled: true };
    if (step.action === "open") {
      opened.push(step.path);
      selected = step.path;
    } else if (step.action === "close") {
      // The browser's `deselect`, allowed. The refused case is
      // `linkedNote.test.ts`'s, which has a real guard to refuse with.
      closed += 1;
      selected = null;
    } else {
      writes.push(step.note);
      note = step.note;
    }
  }
  return { note, selected, writes, opened, closed, settled: false };
}

describe("the rule that keeps ?note= and the open note in step", () => {
  test("a cold load with a link opens it and writes nothing", () => {
    const end = settle({ note: A, selected: null });
    expect(end.settled).toBe(true);
    expect(end.opened).toEqual([A]);
    expect(end.writes).toEqual([]);
  });

  test("a cold load with no link opens nothing and writes nothing", () => {
    const end = settle({ note: null, selected: null });
    expect(end.settled).toBe(true);
    expect(end.opened).toEqual([]);
    expect(end.writes).toEqual([]);
  });

  test("a selection with no link in the URL is addressed", () => {
    const end = settle({ note: null, selected: A });
    expect(end.settled).toBe(true);
    expect(end.writes).toEqual([A]);
    expect(end.opened).toEqual([]);
  });

  test("every start state settles, and settles once", () => {
    /*
      The exhaustive version of the oscillation guard. Sixteen starts, each
      driven to a fixed point: no pair of steps may take turns, and no start may
      need more than one action to reach agreement.
    */
    const values = [null, A, B, "3-resources"] as const;
    for (const note of values) {
      for (const selected of values) {
        const end = settle({ note, selected });
        expect({ note, selected, settled: end.settled }).toEqual({
          note,
          selected,
          settled: true,
        });
        expect(end.writes.length + end.opened.length).toBeLessThanOrEqual(1);
        expect(end.note).toBe(end.selected);
      }
    }
  });

  test("the browser is not acted on until it is on this context", () => {
    // The ordering bug `useLinkedNote` was written for: for one commit the
    // console has chosen a context the file browser has not caught up with, and
    // anything selected in that commit is cleared microseconds later.
    const inputs: AddressInputs = {
      contextId: "w0",
      selectedContextId: CTX,
      urlContextId: CTX,
      note: A,
      selected: null,
      seen: null,
    };
    expect(nextAddressStep(inputs)).toEqual({ action: "wait" });
    expect(nextAddressStep({ ...inputs, contextId: null })).toEqual({ action: "wait" });
    expect(nextAddressStep({ ...inputs, selectedContextId: null })).toEqual({ action: "wait" });
  });

  test("switching contexts makes the new URL the instruction again", () => {
    /*
      `seen` is keyed on the context. Without that, a note reconciled in the old
      context would count as "already seen" in the new one and the link that
      carried somebody there would be treated as stale.
    */
    const seen: Reconciled = { contextId: "w0", note: A, selected: A };
    expect(
      nextAddressStep({
        contextId: CTX,
        selectedContextId: CTX,
        urlContextId: CTX,
        note: A,
        selected: null,
        seen,
      }),
    ).toEqual({ action: "open", path: A });
  });

  test("a URL that has moved to another context is not read against this one", () => {
    /**
     * **The switch bug.** Pressing another context in the rail replaces the
     * URL with `/console/@supa` — no `?note=` — and that lands a commit before
     * the console selects `@supa` and the browser resets under it. Every value
     * this rule reads in that commit is honest and the pair is not: the `note`
     * is `@supa`'s (there is none) and the `selected` is still `@seyi`'s.
     *
     * Without the URL's own context in the inputs, the rule read that as "the
     * URL merely lost its note" and re-addressed the open one — writing
     * `?note=<a @seyi path>` onto `/console/@supa`, which then opened as a link
     * into a context that has never had that file. "I'll change between
     * workspaces and it will say file not found."
     */
    const seen: Reconciled = { contextId: CTX, note: A, selected: A };
    expect(
      nextAddressStep({
        contextId: CTX,
        selectedContextId: CTX,
        urlContextId: "w2",
        note: null,
        selected: A,
        seen,
      }),
    ).toEqual({ action: "wait" });
  });

  test("...and a note the new URL names is not opened in the old context either", () => {
    /*
      The phone's half of the same commit. Its strip restores the path that
      context was last left at (`contextHrefFor`), so the URL arrives carrying
      `@supa`'s note while the browser is still `@seyi` — and `select` there is
      a read of one context's path against the other's bucket.
    */
    const seen: Reconciled = { contextId: CTX, note: A, selected: A };
    expect(
      nextAddressStep({
        contextId: CTX,
        selectedContextId: CTX,
        urlContextId: "w2",
        note: B,
        selected: A,
        seen,
      }),
    ).toEqual({ action: "wait" });
  });

  test("a context the list does not hold is waited on rather than guessed at", () => {
    // `urlContextId` is `null` for a slug that is not in the context list --
    // still loading, or a dead link the layout is about to redirect away from.
    // Neither is a reason to touch the URL or the selection.
    expect(
      nextAddressStep({
        contextId: CTX,
        selectedContextId: CTX,
        urlContextId: null,
        note: A,
        selected: null,
        seen: null,
      }),
    ).toEqual({ action: "wait" });
  });

  test("the switch settles once the browser has caught up", () => {
    // The commit after: everything agrees on `@supa`, the browser's reset has
    // cleared the selection, and the URL names no note. Nothing to do -- and in
    // particular no write, which is what would put the old note back.
    const seen: Reconciled = { contextId: CTX, note: A, selected: A };
    expect(
      nextAddressStep({
        contextId: "w2",
        selectedContextId: "w2",
        urlContextId: "w2",
        note: null,
        selected: null,
        seen,
      }),
    ).toEqual({ action: "hold" });
  });

  test("a link that changes wins over the note that is open", () => {
    const seen: Reconciled = { contextId: CTX, note: A, selected: A };
    expect(
      nextAddressStep({ contextId: CTX, selectedContextId: CTX, urlContextId: CTX, note: B, selected: A, seen }),
    ).toEqual({ action: "open", path: B });
  });

  test("a selection that changes is addressed", () => {
    const seen: Reconciled = { contextId: CTX, note: A, selected: A };
    expect(
      nextAddressStep({ contextId: CTX, selectedContextId: CTX, urlContextId: CTX, note: A, selected: B, seen }),
    ).toEqual({ action: "address", note: B });
  });

  test("a selection cleared by a delete clears the URL", () => {
    const seen: Reconciled = { contextId: CTX, note: A, selected: A };
    expect(
      nextAddressStep({ contextId: CTX, selectedContextId: CTX, urlContextId: CTX, note: A, selected: null, seen }),
    ).toEqual({ action: "address", note: null });
  });

  test("a URL that lost its note closes the note", () => {
    /**
     * The inverse of what this asserted, deliberately. It read "re-addressed
     * rather than obeyed", because there was no close for such a URL to be
     * expressing — and that made the phone's lit context pill, whose whole
     * press is `/console/@slug` with no note, a control that did nothing.
     *
     * `FileBrowser.deselect` is what was missing. The rule is now symmetric: a
     * URL that **changed** is a navigation, and it is honoured whichever way it
     * went. See `linkedNote.test.ts` for the same thing against the real
     * browser, including what happens when the guard refuses.
     */
    const seen: Reconciled = { contextId: CTX, note: A, selected: A };
    expect(
      nextAddressStep({ contextId: CTX, selectedContextId: CTX, urlContextId: CTX, note: null, selected: A, seen }),
    ).toEqual({ action: "close" });
  });

  test("a URL that never had a note does not close what the person just opened", () => {
    /**
     * The case the symmetry must not swallow, and the one that makes "changed"
     * load-bearing rather than decorative.
     *
     * Somebody standing at `/console/@seyi` taps a note. The selection moves;
     * the URL has not been written yet, so `note` is `null` — as it was last
     * time, which is what tells the two apart. Reading *that* as a close would
     * shut every note the moment it was opened, one commit after it opened.
     *
     * SABOTAGE: `if (note === null) return { action: "close" }`. Fails here.
     */
    const seen: Reconciled = { contextId: CTX, note: null, selected: null };
    expect(
      nextAddressStep({ contextId: CTX, selectedContextId: CTX, urlContextId: CTX, note: null, selected: A, seen }),
    ).toEqual({ action: "address", note: A });
  });

  test("a close settles: nothing is left to reconcile once both are empty", () => {
    // What the commit after a close looks like. A rule that answered anything
    // but `hold` here would be the oscillation this module is a pure function
    // to make testable.
    const seen: Reconciled = { contextId: CTX, note: null, selected: A };
    expect(
      nextAddressStep({ contextId: CTX, selectedContextId: CTX, urlContextId: CTX, note: null, selected: null, seen }),
    ).toEqual({ action: "hold" });
  });

  test("agreement is a hold, whatever it agrees on", () => {
    const seen: Reconciled = { contextId: CTX, note: B, selected: A };
    for (const value of [null, A, B]) {
      expect(
        nextAddressStep({
          contextId: CTX,
          selectedContextId: CTX,
          urlContextId: CTX,
          note: value,
          selected: value,
          seen,
        }),
      ).toEqual({ action: "hold" });
    }
  });
});
