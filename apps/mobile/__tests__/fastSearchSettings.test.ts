import { describe, expect, test } from "@jest/globals";
import {
  FAST_SEARCH_STATES,
  describeFastSearch,
  fastSearchControl,
  fastSearchPill,
  fastSearchStateOf,
  indexedLabel,
  shouldReadFastSearch,
  type FastSearchState,
  type FastSearchView,
} from "../features/console/search/fastSearch";

/**
 * The switch that decides whether a copy of somebody's private notes exists in
 * a database we run.
 *
 * `docs/decisions/search.md` argues the two halves — entitlement and opt-in —
 * and the server owns both. What this file holds is the *console's* half of
 * the same rule: it must never offer a control the server would refuse, never
 * synthesise a state it was not told, and never describe the thing being
 * turned on as anything smaller than it is.
 */

const view = (over: Partial<FastSearchView> = {}): FastSearchView => ({
  status: { state: "off", canChange: true },
  loading: false,
  enable: async () => {},
  disable: async () => {},
  ...over,
});

describe("reading a state off the wire", () => {
  test("every state this build knows survives the round trip", () => {
    for (const state of FAST_SEARCH_STATES) {
      expect(fastSearchStateOf(state)).toBe(state);
    }
  });

  test("a state this build has never heard of closes the card down", () => {
    // A newer control plane, a corrupted row, a typo in a fixture. The
    // direction this must fail is "offer nothing and explain", never "off"
    // (which would offer to provision against a vocabulary we do not share)
    // and never "on" (which would claim a copy of somebody's notes exists).
    for (const raw of [undefined, null, "", "ON", "ready", "releasing", 1, {}]) {
      expect(fastSearchStateOf(raw)).toBe("unavailable");
    }
  });
});

describe("which control is offered", () => {
  test("an owner of a context with it off is offered the switch", () => {
    expect(fastSearchControl(view())).toBe("enable");
  });

  test("nothing is offered before the status has landed", () => {
    // `null` is "not answered yet", not "off" — a card that guesses here
    // offers to provision a second database on a slow connection.
    expect(fastSearchControl(view({ status: null }))).toBe("none");
  });

  test("the server's canChange is the whole answer, and is not re-derived", () => {
    // An editor may write every note in this context and may not decide where
    // a copy of all of them is kept. The mutations are owner-only, so a
    // control here would be a button whose only outcome is a permission error.
    for (const state of FAST_SEARCH_STATES) {
      expect(
        fastSearchControl(view({ status: { state, canChange: false } })),
      ).toBe("none");
    }
  });

  test("an action the console does not hold is not drawn as one it does", () => {
    // The demo console on the landing page runs this same card with no
    // mutations behind it. A control there would be a switch that does nothing.
    expect(fastSearchControl(view({ enable: undefined }))).toBe("none");
    expect(
      fastSearchControl(view({ status: { state: "on", canChange: true }, disable: undefined })),
    ).toBe("none");
  });

  test("on and preparing offer the way back out", () => {
    // Preparing included, deliberately: somebody who pressed this by mistake
    // must not have to wait for a provision to finish before undoing it.
    for (const state of ["on", "preparing"] as FastSearchState[]) {
      expect(fastSearchControl(view({ status: { state, canChange: true } }))).toBe(
        "disable",
      );
    }
  });

  test("a failed provision offers a retry, not a fresh turn-on", () => {
    // The row is already opted in, so the press re-runs the provision. A
    // button reading "Turn on" over a switch that is on describes a different
    // act from the one it performs.
    expect(fastSearchControl(view({ status: { state: "failed", canChange: true } }))).toBe(
      "retry",
    );
  });

  test("unavailable offers nothing even to an owner who could change it", () => {
    expect(
      fastSearchControl(view({ status: { state: "unavailable", canChange: true } })),
    ).toBe("none");
  });
});

describe("what the copy has to say", () => {
  test("every state has a heading and a paragraph", () => {
    for (const state of FAST_SEARCH_STATES) {
      const copy = describeFastSearch(state);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.blurb.length).toBeGreaterThan(0);
    }
  });

  test("off and on both name what is copied and where it goes", () => {
    // The consent, in the two states where a person is deciding. Losing either
    // sentence turns an informed choice into a performance switch.
    for (const state of ["off", "on"] as FastSearchState[]) {
      const blurb = describeFastSearch(state).blurb;
      expect(blurb).toMatch(/private notes included/);
      expect(blurb).toMatch(/Supa Media runs/);
    }
  });

  test("on says the delete, off says the bucket keeps working", () => {
    expect(describeFastSearch("on").blurb).toMatch(/deletes that database/);
    expect(describeFastSearch("off").blurb).toMatch(/your own bucket/);
  });

  test("no state describes search as broken while it is off", () => {
    // Off is a working state: the R2 index serves search exactly as it does
    // today. Copy that calls it degraded is how somebody gets talked into
    // turning on a copy of their private notes to clear a warning.
    for (const state of FAST_SEARCH_STATES) {
      const copy = describeFastSearch(state);
      expect(`${copy.title} ${copy.blurb}`).not.toMatch(
        /\b(broken|degraded|unavailable search|search is down|no search)\b/i,
      );
    }
  });
});

describe("the status chip", () => {
  test("only the three states worth a chip get one", () => {
    expect(fastSearchPill("on")).toEqual({ label: "On", tone: "ok" });
    expect(fastSearchPill("preparing")?.tone).toBe("neutral");
    expect(fastSearchPill("failed")?.tone).toBe("warn");
  });

  test("a working state carries no badge to clear", () => {
    expect(fastSearchPill("off")).toBeNull();
    expect(fastSearchPill("unavailable")).toBeNull();
  });
});

describe("the indexed count", () => {
  test("absent is not zero", () => {
    // Nobody has counted yet, which is not the same as a context with nothing
    // in it. Same rule as the storage binding's note count.
    expect(indexedLabel(null)).toBeNull();
    expect(indexedLabel({ state: "preparing", canChange: true })).toBeNull();
  });

  test("a count that exists is printed, with its queue when there is one", () => {
    expect(indexedLabel({ state: "on", canChange: true, notesIndexed: 1284 })).toBe(
      "1,284 notes indexed",
    );
    expect(
      indexedLabel({ state: "preparing", canChange: true, notesIndexed: 20, notesPending: 12 }),
    ).toBe("20 notes indexed · 12 waiting");
  });

  test("an empty queue is not drawn as a stuck one", () => {
    expect(
      indexedLabel({ state: "on", canChange: true, notesIndexed: 6, notesPending: 0 }),
    ).toBe("6 notes indexed");
  });

  test("one note is one note", () => {
    expect(indexedLabel({ state: "on", canChange: true, notesIndexed: 1 })).toBe(
      "1 note indexed",
    );
  });

  test("a measured zero is still printed", () => {
    // The distinction the whole field exists for: something looked and found
    // nothing, which is a fact and not an absence.
    expect(indexedLabel({ state: "on", canChange: true, notesIndexed: 0 })).toBe(
      "0 notes indexed",
    );
  });
});

describe("whether to subscribe", () => {
  test("only where there is a context to ask about", () => {
    expect(shouldReadFastSearch({ workspaceId: null })).toBe(false);
    expect(shouldReadFastSearch({ workspaceId: "ws_1" })).toBe(true);
  });
});
