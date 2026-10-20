/**
 * @jest-environment jsdom
 */

/**
 * THE SEARCH PAGE, MOUNTED: THE WAY OUT, AND THE SLOW NOTE.
 *
 * `consoleSearchPage.test.ts` holds the pure rules (`slowSearchMessage`,
 * `slowSearchRows`); what only exists inside the component is *where* the
 * note appears, that it offers nothing to press (fast search is on for
 * everyone since 2026-10-20), and that there is a way off the page at all — and this file exists because the last
 * one was missing in shipped code. A phone draws no rail and no bottom toolbar
 * on an app-level pane, so the page had exactly one exit: the context strip,
 * whose pill for the context you are in deselected a note and navigated
 * nowhere. You could walk into Search and not walk out.
 *
 * The note is the other half of the same complaint. This page used to search
 * only the contexts with a hosted index and apologise to everybody else —
 * `state: "no-contexts"` over four contexts full of notes. It searches
 * everything now, slowly where it must, and the note sits under the results
 * rather than instead of them.
 *
 * `useBlendedSearch` is mocked rather than driven through Convex: the hook's
 * own contract (debounce, staleness, the timeout race) is `blendedSearchHook`'s
 * job, and re-exercising it here would make every one of these tests about two
 * things at once.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SearchableContext } from "../features/console/search/results";
import type { BlendedSearchView } from "../features/console/search/useBlendedSearch";

const mockUseBlendedSearch = jest.fn((_options: unknown): BlendedSearchView => baseView());

jest.mock("../features/console/search/useBlendedSearch", () => ({
  useBlendedSearch: (options: unknown) => mockUseBlendedSearch(options),
}));

import { SearchPane } from "../features/console/search/SearchPane";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(
  view: BlendedSearchView,
  onOpen = jest.fn(),
  onClose = jest.fn(),
): { text: () => string; onOpen: typeof onOpen; onClose: typeof onClose } {
  mockUseBlendedSearch.mockReturnValue(view);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(SearchPane, {
        query: "review cycle",
        slugs: [],
        onQuery: () => {},
        onScope: () => {},
        onOpen,
        onClose,
      }),
    );
  });
  return { text: () => host?.textContent ?? "", onOpen, onClose };
}

async function openPicker(): Promise<void> {
  const button = [...document.body.querySelectorAll('[role="button"]')].find((node) =>
    (node.getAttribute("aria-label") ?? "").startsWith("Change which contexts are searched"),
  );
  expect(button).toBeDefined();
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      button!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

async function press(testID: string): Promise<void> {
  const node = document.body.querySelector(`[data-testid="${testID}"]`);
  expect(node).toBeTruthy();
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  mockUseBlendedSearch.mockReset();
});

/** One context in reach, with the fields a test cares about set. */
function context(over: Partial<SearchableContext> = {}): SearchableContext {
  return {
    workspaceId: "w1",
    slug: "my-workspace",
    displayName: "My Workspace",
    search: "slow",
    fastSearch: "off",
    owner: true,
    ...over,
  };
}

const hit = {
  workspaceId: "w1",
  slug: "my-workspace",
  displayName: "My Workspace",
  path: "1-projects/review.md",
  title: "Review cycle",
  snippet: "the review cycle runs quarterly",
};

function baseView(over: Partial<BlendedSearchView> = {}): BlendedSearchView {
  return {
    state: "ready",
    results: [hit],
    answer: {
      results: [hit],
      matchCount: 1,
      matchCountIsFloor: false,
      cursor: null,
      sources: [],
      searchableCount: 1,
    },
    contexts: [context()],
    hasMore: false,
    loadingMore: false,
    loadMore: () => {},
    retry: () => {},
    retrying: null,
    notice: null,
    took: null,
    ...over,
  };
}

describe("an answer from the device", () => {
  test("says where it came from, above the results, and offers no upgrade", () => {
    const { text } = mount(
      baseView({ notice: "Searched the copies on this device." }),
    );
    const notice = document.body.querySelector('[data-testid="search-device-notice"]');
    expect(notice?.textContent).toBe("Searched the copies on this device.");
    // The rows are still drawn...
    expect(text()).toContain("Review cycle");
    // ...but "searched from your own bucket" would describe a search that did
    // not happen.
    expect(document.body.querySelector('[data-testid="search-upsell"]')).toBeNull();
  });

  test("draws nothing when the control plane answered", () => {
    mount(baseView());
    expect(document.body.querySelector('[data-testid="search-device-notice"]')).toBeNull();
  });
});

describe("the way out", () => {
  test("the page draws an exit, and pressing it leaves", async () => {
    // The shipped defect, at the level it was reported: a phone's app-level
    // pane has no rail and no bottom toolbar behind it, so a page that draws
    // no exit does not have one.
    const { onClose } = mount(baseView());
    await press("search-close");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("the exit is there on an empty page too", async () => {
    // The state somebody is most likely to want out of is the one where the
    // page has told them nothing.
    const { onClose } = mount(
      baseView({
        state: "no-contexts",
        results: [],
        answer: {
          results: [],
          matchCount: 0,
          matchCountIsFloor: false,
          cursor: null,
          sources: [],
          searchableCount: 0,
        },
        contexts: [],
      }),
    );
    await press("search-close");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("a context with no hosted index is searched, not apologised for", () => {
  test("its results are on the page, and the note is underneath them, with nothing to press", () => {
    const { text } = mount(baseView());

    // Results first — this is the whole change. The page used to draw four
    // lines of apology in their place.
    expect(text()).toContain("Review cycle");
    expect(text()).toContain("was searched from its own bucket");
    // Fast search is on for everyone (2026-10-20): no offer, no switch.
    expect(text()).not.toContain("Turn it on");
    expect(text()).not.toContain("Fast search makes it instant");
    expect(document.body.querySelector('[data-testid="search-upsell"]')).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="search-upsell-my-workspace"] button, [data-testid="search-upsell-my-workspace"] [role="button"]'),
    ).toBeNull();
  });

  test("a context whose hosted index is unavailable is searched from its bucket, with no Premium", () => {
    const { text } = mount(
      baseView({ contexts: [context({ fastSearch: "unavailable" })] }),
    );
    expect(text()).toContain("was searched from its own bucket, which is slower.");
    expect(text()).not.toContain("Premium");
    expect(text()).not.toContain("Fast search");
  });

  test("somebody else's context reads the same, and asks nobody to turn anything on", () => {
    const { text } = mount(
      baseView({
        contexts: [context({ slug: "team-workspace", owner: false })],
        results: [{ ...hit, slug: "team-workspace" }],
      }),
    );
    expect(text()).toContain("@team-workspace was searched from its own bucket");
    expect(text()).not.toContain("turn fast search on");
  });

  test("a context still building its index says so honestly, with nothing to press", () => {
    const { text } = mount(
      baseView({ contexts: [context({ slug: "big-workspace", fastSearch: "preparing" })] }),
    );
    expect(text()).toContain("still being built");
    expect(text()).not.toContain("Nothing matches");
  });

  test("nothing slow means no note at all", () => {
    mount(baseView({ contexts: [context({ search: "fast", fastSearch: "on" })] }));
    expect(document.body.querySelector('[data-testid="search-upsell"]')).toBeNull();
  });

  test("the note waits for an answer rather than riding a half-typed query", () => {
    mount(baseView({ state: "searching", results: [] }));
    expect(document.body.querySelector('[data-testid="search-upsell"]')).toBeNull();
  });
});

describe("the scope chooser", () => {
  test("a slow context is a chip like any other, marked for what it costs", async () => {
    // It used to be missing from the picker entirely — a context somebody
    // belongs to, absent from the list of contexts they can search.
    const { text } = mount(
      baseView({
        contexts: [
          context({ workspaceId: "w1", slug: "fast-workspace", search: "fast", fastSearch: "on" }),
          context({ workspaceId: "w2", slug: "slow-workspace" }),
        ],
      }),
    );
    await openPicker();
    expect(document.body.querySelector('[data-testid="search-chip-slow-workspace"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="search-chip-fast-workspace"]')).toBeTruthy();
    expect(text()).toContain("slower");
  });

  test("the mark is on the exception, so an all-fast account sees no badges", async () => {
    const { text } = mount(
      baseView({ contexts: [context({ search: "fast", fastSearch: "on" })] }),
    );
    await openPicker();
    expect(text()).not.toContain("slower");
  });
});
