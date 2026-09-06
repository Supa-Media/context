import { describe, expect, test } from "@jest/globals";
import {
  FAST_SEARCH_STATES,
  describeFastSearch,
  describeIndexProgress,
  fastSearchControl,
  fastSearchPill,
  fastSearchStateOf,
  indexProgress,
  indexedLabel,
  shouldReadFastSearch,
  type FastSearchState,
  type FastSearchStatus,
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
    // The other half of the bargain, and it was missing from this file for as
    // long as it was missing from the product: an owner consents to a copy of
    // their private notes, and what they get for it is that their searches are
    // answered from it. Pinned so that removing the gateway's read path cannot
    // leave the card promising something nothing does.
    expect(describeFastSearch("on").blurb).toMatch(/searches are answered from/i);
    expect(describeFastSearch("off").blurb).toMatch(/answers your searches from it/i);
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

/* -------------------------------------------------------------------------- */
/*                          how much of it is indexed                          */
/* -------------------------------------------------------------------------- */

/**
 * The percentage, and the four things it must refuse to be.
 *
 * `0 notes indexed` on this one card was the whole of what the console said
 * about a backfill, which is why a stuck one and a working one looked the same
 * for hours. Every case below is a way of putting that back with a `%` sign on
 * it, and each one fails its own assertion when the rule is removed — the
 * sabotage record is at the foot of this block.
 *
 * The owner-only case is the one that is a security property rather than a
 * presentation choice: `notesIndexed` is withheld from a member because the
 * index counts private notes they may not read, so a percentage *of that
 * total* tells them how much they are not being shown. It is asserted here on
 * the pure function and again, mounted, in `fastSearchCard.test.ts` and
 * `indexProgressSurfaces.test.ts`.
 */
const owner = (over: Partial<FastSearchStatus> = {}): FastSearchStatus => ({
  state: "preparing",
  canChange: true,
  notesIndexed: 0,
  ...over,
});

const labelOf = (status: FastSearchStatus | null): string | null =>
  describeIndexProgress(status)?.label ?? null;
const detailOf = (status: FastSearchStatus | null): string | null =>
  describeIndexProgress(status)?.detail ?? null;

describe("the percentage indexed", () => {
  test("a member is told nothing, and 'nothing' is not a zero", () => {
    // The server drops the counters for anyone who is not the owner. Absent
    // has to stay absent all the way to the screen: a `0%` here would be a
    // number derived from a census the server deliberately withheld, and a
    // member could watch it move as private notes were written.
    for (const state of FAST_SEARCH_STATES) {
      const member: FastSearchStatus = { state, canChange: false };
      expect(indexProgress(member)).toBeNull();
      expect(describeIndexProgress(member)).toBeNull();
      expect(labelOf(member)).toBeNull();
      expect(detailOf(member)).toBeNull();
    }
  });

  test("an unanswered status says nothing either", () => {
    expect(indexProgress(null)).toBeNull();
    expect(labelOf(null)).toBeNull();
    expect(detailOf(null)).toBeNull();
  });

  test("a state with no index has no proportion of one", () => {
    // `off` and `unavailable` are working states. A `0% indexed` beside "Fast
    // search is off" is a badge somebody clears by turning on a copy of their
    // private notes — the same reason `fastSearchPill` draws no chip there.
    for (const state of ["off", "unavailable"] as FastSearchState[]) {
      expect(labelOf(owner({ state, notesIndexed: 0, notesPending: 40 }))).toBeNull();
      expect(labelOf(owner({ state, notesIndexed: 900 }))).toBeNull();
    }
  });

  test("a context with no notes is not 0% — it is nothing to index", () => {
    // A percentage of nothing is not a percentage. `0%` over an empty context
    // accuses it of being a stalled one.
    expect(indexProgress(owner({ state: "on", notesIndexed: 0, notesPending: 0 }))).toEqual({
      kind: "empty",
    });
    expect(labelOf(owner({ state: "on", notesIndexed: 0, notesPending: 0 }))).toBe(
      "No notes to index",
    );
    expect(labelOf(owner({ state: "preparing", notesIndexed: 0 }))).toBe(
      "Nothing indexed yet",
    );
    for (const label of [
      labelOf(owner({ state: "on", notesIndexed: 0, notesPending: 0 })),
      labelOf(owner({ state: "preparing", notesIndexed: 0 })),
    ]) {
      expect(label).not.toMatch(/%/);
    }
  });

  test("notes waiting and none arrived is said in words, never as 0%", () => {
    // This is the appearance the missing backfill actually had. A figure that
    // sits at zero reads as a number somebody is computing; a sentence saying
    // nothing has landed reads as the fact it is.
    const stuck = owner({ state: "preparing", notesIndexed: 0, notesPending: 1284 });
    expect(indexProgress(stuck)).toEqual({ kind: "none", pending: 1284 });
    expect(labelOf(stuck)).toBe("Nothing indexed yet");
    expect(labelOf(stuck)).not.toMatch(/%/);
    expect(detailOf(stuck)).toMatch(/None of the 1,284 notes/);
  });

  test("some in and some waiting is the only case with a percentage in it", () => {
    expect(labelOf(owner({ notesIndexed: 620, notesPending: 380 }))).toBe(
      "62% indexed",
    );
    expect(indexProgress(owner({ notesIndexed: 620, notesPending: 380 }))).toEqual({
      kind: "partial",
      percent: 62,
      indexed: 620,
      total: 1000,
    });
  });

  test("one note in ten thousand is 1%, never 0%", () => {
    // `0%` is indistinguishable from the stuck backfill, and this one is not
    // stuck. Rounding down here is how a working index reports itself broken.
    expect(labelOf(owner({ notesIndexed: 1, notesPending: 9_999 }))).toBe(
      "1% indexed",
    );
  });

  test("one note still missing is 99%, never 100%", () => {
    // Somebody who reads 100 stops looking for the note that is not there.
    expect(labelOf(owner({ notesIndexed: 9_999, notesPending: 1 }))).toBe(
      "99% indexed",
    );
  });

  test("preparing with an empty queue is counted, not called finished", () => {
    // `notesIndexed + notesPending` is what the backfill has counted, not what
    // the bucket holds. A `100%` under "Preparing the index" claims a backfill
    // has finished while the control plane says it has not.
    const counting = owner({ state: "preparing", notesIndexed: 1284, notesPending: 0 });
    expect(indexProgress(counting)).toEqual({ kind: "counting", indexed: 1284 });
    expect(labelOf(counting)).toBe("1,284 indexed so far");
    expect(labelOf(counting)).not.toMatch(/100%/);
  });

  test("ready keeps its percentage rather than losing it", () => {
    // The label does not disappear at 100. If it did, "no label" would mean
    // both "everything is in" and "we have nothing to tell you" — which is the
    // absent-versus-zero collapse this console refuses everywhere else, and
    // the reader would be back to guessing whether a backfill had run.
    expect(labelOf(owner({ state: "on", notesIndexed: 1284, notesPending: 0 }))).toBe(
      "100% indexed",
    );
    expect(labelOf(owner({ state: "on", notesIndexed: 6 }))).toBe("100% indexed");
  });

  test("a failed backfill keeps the number it stopped at", () => {
    // How far it got is the most useful thing anybody can be told about a
    // failure, and `failed` already draws Try again beside it.
    expect(
      labelOf(owner({ state: "failed", notesIndexed: 620, notesPending: 380 })),
    ).toBe("Stopped at 62% indexed");
    expect(
      labelOf(owner({ state: "failed", notesIndexed: 40, notesPending: 0 })),
    ).toBe("Stopped after 40 indexed");
    expect(
      labelOf(owner({ state: "failed", notesIndexed: 0, notesPending: 12 })),
    ).toBe("Nothing was indexed");
    expect(detailOf(owner({ state: "failed", notesIndexed: 620, notesPending: 380 })))
      .toMatch(/stopped before it finished/);
  });

  test("the server's own figure is preferred over our arithmetic", () => {
    // The other half of this feature adds a derived percentage to
    // `fastSearch.status`. Where it is present and in range it wins, so the
    // console does not disagree with the control plane about one number.
    expect(
      labelOf(owner({ notesIndexed: 620, notesPending: 380, percentIndexed: 71 })),
    ).toBe("71% indexed");
  });

  test("a figure out of range is refused rather than printed", () => {
    // A total that shrinks under a running pass — notes deleted mid-backfill —
    // leaves `indexed` above the new total. `104%` is a bug report, not
    // progress, so the counts answer instead.
    for (const percentIndexed of [104, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        labelOf(owner({ notesIndexed: 620, notesPending: 380, percentIndexed })),
      ).toBe("62% indexed");
    }
  });

  test("a count that is not a count says nothing at all", () => {
    for (const notesIndexed of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(labelOf(owner({ notesIndexed, notesPending: 10 }))).toBeNull();
    }
    expect(labelOf(owner({ notesIndexed: 10, notesPending: Number.NaN }))).toBeNull();
  });

  test("the tone travels with the words, and only a stopped backfill is warned", () => {
    // Sniffed back out of the label by a caller — matching on "Stopped" — this
    // would go quiet the day the copy is reworded, in the direction where a
    // failed backfill stops looking like one. So it is carried, and asserted.
    expect(describeIndexProgress(owner({ notesIndexed: 620, notesPending: 380 }))?.tone).toBe(
      "quiet",
    );
    expect(describeIndexProgress(owner({ state: "on", notesIndexed: 9 }))?.tone).toBe("quiet");
    expect(
      describeIndexProgress(owner({ state: "failed", notesIndexed: 620, notesPending: 380 }))
        ?.tone,
    ).toBe("warn");
    expect(
      describeIndexProgress(owner({ state: "failed", notesIndexed: 0, notesPending: 3 }))?.tone,
    ).toBe("warn");
  });

  test("nothing this draws could be mistaken for a claim about the bucket", () => {
    // The hosted index is a copy in a database Supa Media runs. Copy that says
    // "your bucket" here would be describing the wrong object entirely.
    for (const state of FAST_SEARCH_STATES) {
      for (const counts of [
        { notesIndexed: 0, notesPending: 0 },
        { notesIndexed: 0, notesPending: 9 },
        { notesIndexed: 9, notesPending: 0 },
        { notesIndexed: 9, notesPending: 9 },
      ]) {
        const detail = detailOf(owner({ state, ...counts }));
        if (detail === null) continue;
        expect(detail).toMatch(/fast-search index|no notes to copy/i);
      }
    }
  });
});

describe("whether to subscribe", () => {
  test("only where there is a context to ask about", () => {
    expect(shouldReadFastSearch({ workspaceId: null })).toBe(false);
    expect(shouldReadFastSearch({ workspaceId: "ws_1" })).toBe(true);
  });
});
