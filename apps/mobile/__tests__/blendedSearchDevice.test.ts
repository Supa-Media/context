/**
 * @jest-environment jsdom
 */

/**
 * The search page with no connection answers from the device — at once, over
 * the console's own context list, and saying so — and online it falls back to
 * the device only when the control plane's request failed.
 *
 * On the real hook with the Convex client mocked, because the rule lives
 * between the debounce, the action and the `await`, where no pure function can
 * reach it. The blend itself is `deviceBlendedSearch.test.ts`.
 *
 * Sabotage: asking the control plane first while offline reddens "offline,
 * the page never asks the control plane"; searching every context regardless
 * of the URL's scope reddens "the URL's scope is honoured offline too".
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DeviceSearchAnswer } from "../features/offline/mirrorSearch";

const mockClient = { action: jest.fn<(...args: unknown[]) => Promise<unknown>>() };
jest.mock("convex/react", () => ({
  useConvex: () => mockClient,
  // Offline, the subscription has nothing — which is the case being tested.
  useQueries: () => ({ contexts: undefined }),
}));

import {
  useBlendedSearch,
  type BlendedDeviceSearch,
  type BlendedSearchView,
} from "../features/console/search/useBlendedSearch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONTEXTS = [
  { workspaceId: "ws_alice", slug: "alice", displayName: "Alice", role: "owner" },
  { workspaceId: "ws_team", slug: "team", displayName: "Team", role: "member" },
];

function found(path: string): DeviceSearchAnswer {
  return {
    hits: [{ path, title: path, snippets: ["a line"] }],
    matchCount: 1,
    searched: 5,
    encryptedSkipped: 0,
    mirrored: true,
  };
}

function device(reachability: BlendedDeviceSearch["reachability"]) {
  const search = jest.fn(async (context: { workspaceId: string }) =>
    found(`${context.workspaceId}.md`),
  );
  const value: BlendedDeviceSearch = {
    reachability,
    contexts: CONTEXTS,
    statuses: new Map([
      ["ws_alice", { state: "synced", notes: 5, bytes: 1, lastSyncedAt: 1 }],
      ["ws_team", { state: "synced", notes: 5, bytes: 1, lastSyncedAt: 1 }],
    ]),
    search,
  };
  return { value, search };
}

function mount(query: string, slugs: string[], local: BlendedDeviceSearch) {
  const seen: { current: BlendedSearchView | null } = { current: null };
  const host = document.createElement("div");
  let root: Root | null = null;
  function Probe({ scope }: { scope: string[] }) {
    seen.current = useBlendedSearch({ query, slugs: scope, device: local });
    return null;
  }
  act(() => {
    root = createRoot(host);
    root.render(createElement(Probe, { scope: slugs }));
  });
  return {
    view: () => seen.current as BlendedSearchView,
    /** Re-render as the route does: the same slugs, parsed into a new array. */
    rerender: (scope: string[]) =>
      act(() => (root as unknown as Root).render(createElement(Probe, { scope }))),
    unmount: () => act(() => (root as unknown as Root).unmount()),
  };
}

async function settle(ms = 300) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockClient.action.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("the search page with no connection", () => {
  test("offline, the page never asks the control plane", async () => {
    const local = device("offline");
    const app = mount("review", [], local.value);
    await settle();
    expect(mockClient.action).not.toHaveBeenCalled();
    expect(app.view().results.map((row) => row.path)).toEqual(["ws_alice.md", "ws_team.md"]);
    expect(app.view().state).toBe("ready");
    expect(app.view().notice).toBe("Searched the copies on this device.");
    expect(app.view().hasMore).toBe(false);
    app.unmount();
  });

  test("the URL's scope is honoured offline too", async () => {
    const local = device("offline");
    const app = mount("review", ["team"], local.value);
    await settle();
    expect(local.search).toHaveBeenCalledTimes(1);
    expect(local.search.mock.calls[0]![0]).toMatchObject({ workspaceId: "ws_team", role: "member" });
    expect(app.view().results.map((row) => row.slug)).toEqual(["team"]);
    app.unmount();
  });

  test("a re-render with the same scope, freshly parsed, does not search again", async () => {
    // The route parses `?in=` into a new array on every render, and it
    // re-renders whenever a mirror status ticks during a download.
    const local = device("offline");
    const app = mount("review", ["team"], local.value);
    await settle();
    expect(local.search).toHaveBeenCalledTimes(1);
    app.rerender(["team"]);
    app.rerender(["team"]);
    await settle();
    expect(local.search).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  test("online, a failed request falls back to the device and says so", async () => {
    mockClient.action.mockImplementation(async () => {
      throw new Error("network");
    });
    const local = device("online");
    const app = mount("review", [], local.value);
    await settle();
    expect(mockClient.action).toHaveBeenCalled();
    expect(app.view().state).toBe("ready");
    expect(app.view().notice).toMatch(/^Search could not reach your contexts/);
    app.unmount();
  });

  test("online, a working request is the answer and the device is not read", async () => {
    mockClient.action.mockImplementation(async () => ({
      results: [],
      matchCount: 0,
      matchCountIsFloor: false,
      cursor: null,
      sources: [],
      searchableCount: 2,
    }));
    const local = device("online");
    const app = mount("review", [], local.value);
    await settle();
    expect(local.search).not.toHaveBeenCalled();
    expect(app.view().notice).toBeNull();
    app.unmount();
  });
});
