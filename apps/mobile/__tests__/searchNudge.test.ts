/**
 * @jest-environment jsdom
 */

/**
 * THE NUDGE, MOUNTED.
 *
 * `consoleSearchPage.test.ts` holds the pure rules (`nudgeMessage`,
 * `nudgeRows`, `ownsAnUnsearchableContext`); what only exists inside the
 * component is *where* the nudge appears and *what a press on it does* — the
 * reviewer's complaint on #262 was about a page, not a function, and a rule
 * that is correct in `results.ts` and never rendered anywhere is the same bug
 * with an extra file between it and the person reading the page.
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
import type { BlendedSearchView } from "../features/console/search/useBlendedSearch";

const mockUseBlendedSearch = jest.fn((_options: unknown): BlendedSearchView => baseView());

jest.mock("../features/console/search/useBlendedSearch", () => ({
  useBlendedSearch: (options: unknown) => mockUseBlendedSearch(options),
}));

import { SearchPane } from "../features/console/search/SearchPane";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(view: BlendedSearchView, onOpen = jest.fn()): { text: () => string; onOpen: typeof onOpen } {
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
      }),
    );
  });
  return { text: () => host?.textContent ?? "", onOpen };
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

function baseView(over: Partial<BlendedSearchView> = {}): BlendedSearchView {
  return {
    state: "no-contexts",
    results: [],
    answer: { results: [], matchCount: 0, matchCountIsFloor: false, cursor: null, sources: [], eligibleCount: 0 },
    eligible: [],
    notEligible: [],
    hasMore: false,
    loadingMore: false,
    loadMore: () => {},
    retry: () => {},
    retrying: null,
    ...over,
  };
}

describe("zero eligible contexts", () => {
  // `settings=search`, not the default section. This row exists to turn fast
  // search on; landing on the bucket binding leaves the control it names a
  // sidebar click away, and on a phone a back-to-the-list away.
  test("names an owned context and presses through to its settings", async () => {
    const { text, onOpen } = mount(
      baseView({
        notEligible: [
          {
            workspaceId: "w1",
            slug: "my-brain",
            displayName: "My Brain",
            owner: true,
            state: "off",
          },
        ],
      }),
    );

    expect(text()).toContain("No context you can reach has fast search switched on");
    expect(text()).toContain("Fast search is off for @my-brain");

    await press("search-nudge-open-my-brain");
    expect(onOpen).toHaveBeenCalledWith("/console/@my-brain?settings=search");
  });

  test("names a shared context by its owner, with nothing to press", async () => {
    const { text } = mount(
      baseView({
        notEligible: [
          {
            workspaceId: "w2",
            slug: "team-brain",
            displayName: "Team Brain",
            owner: false,
            state: "off",
          },
        ],
      }),
    );

    expect(text()).toContain("team-brain");
    expect(text()).toContain("owner has not turned fast search on");
    expect(document.body.querySelector('[data-testid="search-nudge-open-team-brain"]')).toBeNull();
  });

  test("a context still building its index says so, honestly, with nothing to press", async () => {
    const { text } = mount(
      baseView({
        notEligible: [
          {
            workspaceId: "w3",
            slug: "big-brain",
            displayName: "Big Brain",
            owner: true,
            state: "preparing",
          },
        ],
      }),
    );

    expect(text()).toContain("big-brain");
    expect(text()).toContain("still being indexed");
    expect(text()).not.toContain("Nothing matches");
    expect(document.body.querySelector('[data-testid="search-nudge-open-big-brain"]')).toBeNull();
  });

  test("nothing to nudge about still shows the plain sentence, not a blank list", () => {
    const { text } = mount(baseView({ notEligible: [] }));
    expect(text()).toContain("No context you can reach has fast search switched on");
    expect(document.body.querySelector('[data-testid="search-nudge"]')).toBeNull();
  });
});

describe("the scope chooser", () => {
  test("an owner with some eligible contexts still sees the one that is not", async () => {
    const { text } = mount(
      baseView({
        state: "empty",
        answer: {
          results: [],
          matchCount: 0,
          matchCountIsFloor: false,
          cursor: null,
          sources: [],
          eligibleCount: 1,
        },
        eligible: [{ workspaceId: "w1", slug: "my-brain", displayName: "My Brain" }],
        notEligible: [
          {
            workspaceId: "w2",
            slug: "second-brain",
            displayName: "Second Brain",
            owner: true,
            state: "off",
          },
        ],
      }),
    );

    await openPicker();
    expect(document.body.querySelector('[data-testid="search-scope-nudge"]')).toBeTruthy();
    expect(text()).toContain("second-brain");
  });

  test("a member with every eligible context already searched sees no nudge at all", async () => {
    mount(
      baseView({
        state: "empty",
        answer: {
          results: [],
          matchCount: 0,
          matchCountIsFloor: false,
          cursor: null,
          sources: [],
          eligibleCount: 1,
        },
        eligible: [{ workspaceId: "w1", slug: "my-brain", displayName: "My Brain" }],
        notEligible: [
          {
            workspaceId: "w2",
            slug: "someone-elses-brain",
            displayName: "Someone Else's Brain",
            owner: false,
            state: "off",
          },
        ],
      }),
    );

    await openPicker();
    // Something eligible exists, and the only not-eligible context is not this
    // viewer's to turn on — there is nothing for them to do here, so the
    // picker stays chips-only rather than a row about a switch they cannot
    // press.
    expect(document.body.querySelector('[data-testid="search-scope-nudge"]')).toBeNull();
  });
});
