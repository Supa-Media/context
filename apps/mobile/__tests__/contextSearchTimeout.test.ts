/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  SEARCH_TIMEOUT_MS,
  useContextSearch,
  type ContextSearch,
} from "../features/console/files/useContextSearch";
import type { SearchAnswer } from "../features/console/files/browser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A search that never comes back must stop saying it is searching.
 *
 * ## The trap, for the fourth time in this console
 *
 * `searchContext` is a Convex **action**, and `ConvexReactClient.action()` has
 * no client-side timeout: offline, the promise neither resolves nor rejects.
 * The palette's own state machine has nothing else to move it, so
 * "Searching the rest of this context…" is what a person is left looking at,
 * with no way out but retyping the query — and retyping starts another one.
 *
 * It is the same defect as the note save (`saveTimeout.test.ts`), the storage
 * connect (`connectTimeout.test.ts`) and the file operation
 * (`fileOperationTimeout.test.ts`), one surface over. The console's rule is
 * that an absent capability is reported and never faked; a spinner is the one
 * state that reports nothing and cannot be acted on.
 *
 * ## What is asserted
 *
 * The three settled outcomes and the one unsettled one, on the real hook with
 * a controlled clock — a pure function cannot reach the timer, which lives
 * between `setState("searching")` and the action.
 *
 * A **failure and a timeout land in the same state on purpose.** They are
 * different sentences to a person in `features/offline`, where one is a
 * provider's refusal and the other an unknown; here both mean this half of the
 * palette has no answer, and the copy the palette already draws for `failed`
 * says exactly that — the local filename filter kept working, and only the
 * folders it had loaded were searched.
 */

/** Mount the hook and hand the test its current value. */
function mount(search: ((query: string) => Promise<SearchAnswer>) | null) {
  const seen: { current: ContextSearch | null } = { current: null };
  const host = document.createElement("div");
  const root = createRoot(host);

  function Probe() {
    seen.current = useContextSearch(search);
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });
  return {
    get value() {
      return seen.current!;
    },
    unmount() {
      act(() => root.unmount());
    },
  };
}

/**
 * Type a query and run **exactly** the debounce out, so the request is sent and
 * none of its own deadline has been spent yet. Advancing further here would
 * charge the search for time it was not running, and the "one tick short"
 * assertion below is the one that would quietly stop meaning anything.
 */
const DEBOUNCE_MS = 250;
function type(probe: { value: ContextSearch }, query: string) {
  act(() => probe.value.onQuery(query));
  act(() => {
    jest.advanceTimersByTime(DEBOUNCE_MS);
  });
}

const answer = (over: Partial<SearchAnswer> = {}): SearchAnswer => ({
  hits: [],
  indexMissing: false,
  indexIncomplete: false,
  ...over,
});

describe("a console search that never answers", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("stops saying it is searching, and says so", async () => {
    // The shape of an action lost to a dead uplink: no resolve, no reject.
    const probe = mount(() => new Promise<SearchAnswer>(() => {}));
    type(probe, "layomi");
    expect(probe.value.state).toBe("searching");

    // One tick short of the deadline it is still a live request, because a
    // timeout that fired early would call a slow bucket a broken one.
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_TIMEOUT_MS - 1);
    });
    expect(probe.value.state).toBe("searching");

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(probe.value.state).toBe("failed");
    expect(probe.value.items).toEqual([]);
    probe.unmount();
  });

  test("a late answer to a query nobody is waiting for is dropped", async () => {
    let settle: ((value: SearchAnswer) => void) | null = null;
    const probe = mount(
      () =>
        new Promise<SearchAnswer>((resolve) => {
          settle = resolve;
        }),
    );
    type(probe, "layomi");
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_TIMEOUT_MS);
    });
    expect(probe.value.state).toBe("failed");

    // The request the palette gave up on comes back. Showing it now would put
    // results under a line that says the search could not be run.
    await act(async () => {
      settle?.(
        answer({
          hits: [{ path: "2-areas/people/layomi.md", title: "Layomi", snippets: ["a line"] }],
        }),
      );
    });
    expect(probe.value.state).toBe("failed");
    expect(probe.value.items).toEqual([]);
    probe.unmount();
  });

  test("an answer inside the deadline is the answer", async () => {
    const probe = mount(async () =>
      answer({
        hits: [{ path: "2-areas/people/layomi.md", title: "Layomi", snippets: ["a line"] }],
      }),
    );
    type(probe, "layomi");
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(probe.value.state).toBe("ready");
    expect(probe.value.items.map((item) => item.id)).toEqual(["2-areas/people/layomi.md"]);
    probe.unmount();
  });

  test("an index that has not caught up is its own state, never a miss", async () => {
    const probe = mount(async () => answer({ indexMissing: true }));
    type(probe, "layomi");
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    // The distinction the palette renders differently from "nothing matches",
    // and the reason a cold bucket does not tell somebody their note is gone.
    expect(probe.value.state).toBe("indexing");
    probe.unmount();
  });

  test("a rejection is the same dead end as a timeout, without waiting for one", async () => {
    const probe = mount(async () => {
      throw new Error("the action refused");
    });
    type(probe, "layomi");
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(probe.value.state).toBe("failed");
    probe.unmount();
  });
});
