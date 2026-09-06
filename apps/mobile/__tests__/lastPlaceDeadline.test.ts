/**
 * @jest-environment jsdom
 */

/**
 * A DEVICE THAT NEVER ANSWERS MUST NOT HOLD THE LANDING.
 *
 * `useLastPlace` answers `undefined` while it is asking, and `/console` paints
 * nothing for that state when it has contexts in hand. So an unbounded read is
 * a screen the app cannot leave — and the read is `AsyncStorage`, which
 * `forget.ts` already states the rule for in its own words: **a bridge call,
 * and a wedged bridge never settles**, so a `catch` is half a failure stance
 * and the other half is a deadline.
 *
 * That module learned it from a sign-out button that could hang. This one
 * learned it from a phone: relaunching the app landed on a blank page with the
 * personal brain in the rail, which is this hook's `undefined` rendered.
 *
 * Two properties, and the second is the one a lazier test would skip:
 *
 *  1. A store that never settles is a device that does not know, by the
 *     deadline — never `undefined` forever.
 *  2. A store that answers **normally** is not cut off by the deadline, and its
 *     answer is the real one. A hook that always resolved `null` would pass (1)
 *     and have deleted the feature.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What the mocked store's `get` does. Swapped per test.
 *
 * `mock`-prefixed because Jest hoists `jest.mock` above every other statement
 * and refuses a factory that closes over anything else — the guard against a
 * factory reading a variable that has not been initialised yet.
 */
let mockGet: (key: string) => Promise<string | null> = async () => null;

jest.mock("../features/offline/store", () => ({
  openStore: () => ({
    durable: true,
    get: (key: string) => mockGet(key),
    set: async () => {},
    remove: async () => {},
    keys: async () => [],
  }),
}));

import { RECALL_DEADLINE_MS } from "../features/console/lastPlace";
import { useLastPlace } from "../features/console/useLastPlace";

/** Every value the hook has reported, in order. */
function mount(): { seen: unknown[]; root: Root; container: HTMLDivElement } {
  const seen: unknown[] = [];
  function Probe() {
    seen.push(useLastPlace());
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(Probe)));
  return { seen, root, container };
}

let mounted: { root: Root; container: HTMLDivElement } | null = null;
afterEach(() => {
  if (mounted) {
    const held = mounted;
    act(() => held.root.unmount());
    held.container.remove();
    mounted = null;
  }
  jest.useRealTimers();
});

describe("the read is bounded", () => {
  test("a store that never answers becomes a device that does not know", () => {
    jest.useFakeTimers();
    // The wedged bridge, exactly: a promise nothing ever settles.
    mockGet = () => new Promise<string | null>(() => {});

    const { seen, root, container } = mount();
    mounted = { root, container };
    expect(seen[seen.length - 1]).toBeUndefined();

    act(() => {
      jest.advanceTimersByTime(RECALL_DEADLINE_MS + 1);
    });
    expect(seen[seen.length - 1]).toBeNull();
  });

  test("a store that answers is not cut off, and its answer is the one used", async () => {
    // The negative control for the deadline. Without it, a hook hard-wired to
    // `null` would pass the test above and have removed the feature.
    // The stored shape is a log, most recent first; the landing reads its head.
    mockGet = async () => JSON.stringify([{ slug: "seyi", note: "3-resources/books/x.md" }]);

    const { seen, root, container } = mount();
    mounted = { root, container };
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    expect(seen[seen.length - 1]).toEqual({ slug: "seyi", note: "3-resources/books/x.md" });
  });

  test("a late answer does not overwrite the deadline's", async () => {
    /*
      The bridge waking up after the landing has already moved on. Reporting the
      place then would resolve a redirect for a screen nobody is on — the same
      reason the unmount guard exists, arrived at from the other direction.
    */
    jest.useFakeTimers();
    let answer: ((value: string | null) => void) | null = null;
    mockGet = () => new Promise<string | null>((resolve) => {
      answer = resolve;
    });

    const { seen, root, container } = mount();
    mounted = { root, container };
    act(() => {
      jest.advanceTimersByTime(RECALL_DEADLINE_MS + 1);
    });
    expect(seen[seen.length - 1]).toBeNull();

    await act(async () => {
      answer?.(JSON.stringify([{ slug: "seyi", note: "late.md" }]));
      await Promise.resolve();
    });
    expect(seen[seen.length - 1]).toBeNull();
  });
});
