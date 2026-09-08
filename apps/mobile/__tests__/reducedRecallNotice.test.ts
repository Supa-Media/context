/**
 * @jest-environment jsdom
 */

/**
 * The console's own copy of "a shed index must say so to the caller it
 * happened to" (`docs/decisions/search.md`), and the two things that make it
 * safe rather than a fourth version of the sentence:
 *
 *  - **Bounded.** The reviewer measured a real mailbox turning this into
 *    23,000 characters of warning in `apps/mcp/src/index.js`'s two surfaces
 *    (`toolSearchNotes` and `orient`) before it was fixed there by naming a
 *    limited number of notes and counting the rest. `splitReducedRecallNotes`
 *    and `reducedRecallMessage` are the console's copy of that shape, at its
 *    own limit.
 *  - **Threaded, not folded into `state`.** `indexing` disappears the moment
 *    there are hits; a shed note's gap does not close on its own, so
 *    `useContextSearch`'s `reducedRecallNotes` has to survive exactly where
 *    `indexing` does not — this file's hook tests are the ones that would
 *    catch it being cleared alongside `state` by an over-eager refactor.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  REDUCED_RECALL_DISPLAY_LIMIT,
  reducedRecallMessage,
  splitReducedRecallNotes,
  useContextSearch,
  type ContextSearch,
} from "../features/console/files/useContextSearch";
import type { SearchAnswer } from "../features/console/files/browser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATHS = [
  "0-inbox/email/name-at-example-com/2026-09-01.md",
  "0-inbox/email/name-at-example-com/2026-09-02.md",
  "0-inbox/email/name-at-example-com/2026-09-03.md",
  "0-inbox/email/name-at-example-com/2026-09-04.md",
  "0-inbox/email/name-at-example-com/2026-09-05.md",
];

describe("splitReducedRecallNotes", () => {
  test("under the limit, nothing is left over", () => {
    const { shown, rest } = splitReducedRecallNotes(PATHS.slice(0, 2));
    expect(shown).toEqual(PATHS.slice(0, 2));
    expect(rest).toBe(0);
  });

  test("past the limit, the rest is counted rather than dropped or shown", () => {
    const { shown, rest } = splitReducedRecallNotes(PATHS);
    expect(shown).toEqual(PATHS.slice(0, REDUCED_RECALL_DISPLAY_LIMIT));
    expect(rest).toBe(PATHS.length - REDUCED_RECALL_DISPLAY_LIMIT);
  });

  test("an empty list is exactly that, never a negative remainder", () => {
    expect(splitReducedRecallNotes([])).toEqual({ shown: [], rest: 0 });
  });
});

describe("reducedRecallMessage", () => {
  test("null for nothing shed — the palette renders no banner at all", () => {
    expect(reducedRecallMessage([])).toBeNull();
  });

  test("names the one note, singular, and says it still exists", () => {
    const text = reducedRecallMessage([PATHS[0]]);
    expect(text).toContain("1 note holds");
    expect(text).toContain(PATHS[0]);
    expect(text).toContain("still exists");
    expect(text).toContain("opening it always shows it whole");
    // Never "proof the content is gone" without the qualifier — a shed note
    // is reduced, not deleted.
    expect(text).toContain("is not proof the content is gone");
  });

  test("plural agreement past one note", () => {
    const text = reducedRecallMessage(PATHS.slice(0, 2));
    expect(text).toContain("2 notes hold");
  });

  test("bounded: named to the limit, the remainder counted and never silently truncated", () => {
    const text = reducedRecallMessage(PATHS)!;
    for (const path of PATHS.slice(0, REDUCED_RECALL_DISPLAY_LIMIT)) {
      expect(text).toContain(path);
    }
    for (const path of PATHS.slice(REDUCED_RECALL_DISPLAY_LIMIT)) {
      expect(text).not.toContain(path);
    }
    expect(text).toContain(`(+${PATHS.length - REDUCED_RECALL_DISPLAY_LIMIT} more)`);
  });

  test("the message does not grow with the mailbox", () => {
    const small = reducedRecallMessage(PATHS.slice(0, REDUCED_RECALL_DISPLAY_LIMIT))!;
    const huge = reducedRecallMessage(
      Array.from({ length: 400 }, (_, index) => `0-inbox/email/x/2026-${index}.md`),
    )!;
    // The count digits differ; the shape and the named-note count do not.
    expect(huge.length).toBeLessThan(small.length + 40);
  });
});

/* -------------------------------------------------------------------------- */
/*                    the hook: threaded beside `state`, not inside it        */
/* -------------------------------------------------------------------------- */

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
  reducedRecall: false,
  reducedRecallNotes: [],
  ...over,
});

describe("useContextSearch carries the shed-note field", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("idle, with nothing typed, claims nothing", () => {
    const probe = mount(async () => answer());
    expect(probe.value.reducedRecallNotes).toEqual([]);
    probe.unmount();
  });

  test("an answer with hits still carries the caveat — it is not folded into `state`", async () => {
    const probe = mount(async () =>
      answer({
        hits: [{ path: "1-projects/foo.md", title: "foo", snippets: [] }],
        reducedRecallNotes: ["0-inbox/email/name-at-example-com/2026-09-07.md"],
      }),
    );
    type(probe, "layomi");
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(probe.value.state).toBe("ready");
    expect(probe.value.reducedRecallNotes).toEqual([
      "0-inbox/email/name-at-example-com/2026-09-07.md",
    ]);
    probe.unmount();
  });

  test("a new, too-short query clears the previous answer's caveat", async () => {
    const probe = mount(async () =>
      answer({ reducedRecallNotes: ["0-inbox/email/x/2026-09-07.md"] }),
    );
    type(probe, "layomi");
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(probe.value.reducedRecallNotes).toEqual(["0-inbox/email/x/2026-09-07.md"]);

    act(() => probe.value.onQuery("l"));
    expect(probe.value.reducedRecallNotes).toEqual([]);
    probe.unmount();
  });

  test("a search that times out claims nothing — a dead uplink is not evidence of shedding", async () => {
    const probe = mount(() => new Promise<SearchAnswer>(() => {}));
    type(probe, "layomi");
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(probe.value.state).toBe("failed");
    expect(probe.value.reducedRecallNotes).toEqual([]);
    probe.unmount();
  });

  test("a rejected search claims nothing either", async () => {
    const probe = mount(async () => {
      throw new Error("the action refused");
    });
    type(probe, "layomi");
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(probe.value.state).toBe("failed");
    expect(probe.value.reducedRecallNotes).toEqual([]);
    probe.unmount();
  });
});
