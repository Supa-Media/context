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

  for (let pass = 0; pass < passes; pass += 1) {
    const inputs: AddressInputs = {
      contextId: CTX,
      selectedContextId: CTX,
      note,
      selected,
      seen,
    };
    const step = nextAddressStep(inputs);
    if (step.action === "wait") return { note, selected, writes, opened, settled: false };
    // The hook records before acting; see `useNoteAddress` for why.
    seen = { contextId: CTX, note, selected };
    if (step.action === "hold") return { note, selected, writes, opened, settled: true };
    if (step.action === "open") {
      opened.push(step.path);
      selected = step.path;
    } else {
      writes.push(step.note);
      note = step.note;
    }
  }
  return { note, selected, writes, opened, settled: false };
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
        note: A,
        selected: null,
        seen,
      }),
    ).toEqual({ action: "open", path: A });
  });

  test("a link that changes wins over the note that is open", () => {
    const seen: Reconciled = { contextId: CTX, note: A, selected: A };
    expect(
      nextAddressStep({ contextId: CTX, selectedContextId: CTX, note: B, selected: A, seen }),
    ).toEqual({ action: "open", path: B });
  });

  test("a selection that changes is addressed", () => {
    const seen: Reconciled = { contextId: CTX, note: A, selected: A };
    expect(
      nextAddressStep({ contextId: CTX, selectedContextId: CTX, note: A, selected: B, seen }),
    ).toEqual({ action: "address", note: B });
  });

  test("a selection cleared by a delete clears the URL", () => {
    const seen: Reconciled = { contextId: CTX, note: A, selected: A };
    expect(
      nextAddressStep({ contextId: CTX, selectedContextId: CTX, note: A, selected: null, seen }),
    ).toEqual({ action: "address", note: null });
  });

  test("a URL that lost its note is re-addressed rather than obeyed", () => {
    const seen: Reconciled = { contextId: CTX, note: A, selected: A };
    expect(
      nextAddressStep({ contextId: CTX, selectedContextId: CTX, note: null, selected: A, seen }),
    ).toEqual({ action: "address", note: A });
  });

  test("agreement is a hold, whatever it agrees on", () => {
    const seen: Reconciled = { contextId: CTX, note: B, selected: A };
    for (const value of [null, A, B]) {
      expect(
        nextAddressStep({
          contextId: CTX,
          selectedContextId: CTX,
          note: value,
          selected: value,
          seen,
        }),
      ).toEqual({ action: "hold" });
    }
  });
});
