/**
 * @jest-environment jsdom
 */

/**
 * A button that goes down and never comes back up.
 *
 * `useBlendedSearch` holds two flags that disable a control while a request is
 * out — `loadingMore` behind "Load more", `retrying` behind a failed source's
 * "Retry" — and both requests also carry a staleness guard, because an answer
 * for a question nobody is asking any more must not reach the list.
 *
 * The two are different concerns, and clearing the flag *behind* the guard
 * conflates them: change the query while a page is in flight and the settle
 * returns early, the flag stays raised, and the button is dead for the rest of
 * the page's life. It is not a flicker — nothing ever puts it down again, and
 * the only way out is a reload.
 *
 * That is the defect these two tests pin. They are on the real hook rather
 * than on a model, because the bug lives between a `setState` and an `await`
 * and no pure function can be handed the in-flight request.
 *
 * Sabotage: moving either `setLoadingMore(false)` or `setRetrying(null)` back
 * under the `asked.current !== forQuestion` guard reddens exactly one of them.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const mockClient = { action: jest.fn() };
const mockEligible = [
  { workspaceId: "ws_alice", slug: "alice", displayName: "Alice" },
  { workspaceId: "ws_team", slug: "team", displayName: "Team" },
];

jest.mock("convex/react", () => ({
  useConvex: () => mockClient,
  useQueries: () => ({ contexts: { eligible: mockEligible, notEligible: [] } }),
}));

import {
  useBlendedSearch,
  type BlendedSearchView,
} from "../features/console/search/useBlendedSearch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** One page, optionally with another behind it so "Load more" is offered. */
function page(cursor: string | null, ...slugs: string[]) {
  return {
    results: slugs.map((slug, index) => ({
      workspaceId: `ws_${slug}`,
      slug,
      displayName: slug,
      path: `1-projects/${slug}-${index}.md`,
      title: `${slug} ${index}`,
      snippet: "",
    })),
    matchCount: slugs.length,
    matchCountIsFloor: false,
    cursor,
    sources: slugs.map((slug) => ({
      workspaceId: `ws_${slug}`,
      slug,
      displayName: slug,
      state: "ok" as const,
      matchCount: 1,
      matchCountIsFloor: false,
    })),
    eligibleCount: 2,
  };
}

interface Mounted {
  view: () => BlendedSearchView;
  retype: (query: string) => void;
  unmount: () => void;
}

function mount(query: string): Mounted {
  const seen: { current: BlendedSearchView | null } = { current: null };
  const host = document.createElement("div");
  let root: Root | null = null;

  function Probe({ q }: { q: string }) {
    seen.current = useBlendedSearch({ query: q, slugs: [] });
    return null;
  }

  act(() => {
    root = createRoot(host);
    root.render(createElement(Probe, { q: query }));
  });

  return {
    view: () => seen.current as BlendedSearchView,
    retype: (next: string) => {
      act(() => {
        (root as unknown as Root).render(createElement(Probe, { q: next }));
      });
    },
    unmount: () => {
      act(() => {
        (root as unknown as Root).unmount();
      });
    },
  };
}

/** A promise this test decides when to settle. */
function deferred() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockClient.action.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("a request the question outlived", () => {
  test("does not leave 'Load more' loading forever", async () => {
    mockClient.action.mockImplementation(async () => page("cursor-1", "alice"));

    const app = mount("review cycle");
    // The debounce, then the first page.
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(app.view().hasMore).toBe(true);

    // A second page that has not come back yet.
    const slow = deferred();
    mockClient.action.mockImplementation(async () => await slow.promise);
    act(() => {
      app.view().loadMore();
    });
    expect(app.view().loadingMore).toBe(true);

    // The question changes underneath it — another letter, or a chip — and the
    // debounce fires, which is what makes the in-flight page stale. Its own
    // request is left hanging so only the stale settle below moves anything.
    app.retype("review cycles");
    const never = deferred();
    mockClient.action.mockImplementation(async () => await never.promise);
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    await act(async () => {
      slow.resolve(page(null, "alice"));
      await Promise.resolve();
    });

    // The page it answered is not appended: it belongs to a question nobody is
    // asking. But the button is a control rather than an answer, and it comes
    // back up — leaving it down is a "Load more" that can never be pressed.
    expect(app.view().loadingMore).toBe(false);
    app.unmount();
  });

  test("does not leave 'Retry' retrying forever", async () => {
    mockClient.action.mockImplementation(async () => page(null, "alice"));
    const app = mount("review cycle");
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    const slow = deferred();
    mockClient.action.mockImplementation(async () => await slow.promise);
    act(() => {
      app.view().retry("ws_team");
    });
    expect(app.view().retrying).toBe("ws_team");

    app.retype("review cycles");
    const never = deferred();
    mockClient.action.mockImplementation(async () => await never.promise);
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    await act(async () => {
      slow.resolve(page(null, "team"));
      await Promise.resolve();
    });

    expect(app.view().retrying).toBeNull();
    app.unmount();
  });
});
