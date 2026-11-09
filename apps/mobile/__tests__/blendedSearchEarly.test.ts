/**
 * @jest-environment jsdom
 */

/*
 * THE PHONE'S COPY ANSWERS FIRST (owner, 2026-11-09).
 *
 * On a runtime that keeps a device copy of notes, a search the control plane
 * has not answered within 400 ms is drawn from the device at once, with no
 * notice: the server's answer replaces it when it lands, and a server that
 * fails after that leaves the device answer under the "could not reach" notice.
 * A server that answers inside 400 ms is the only answer ever drawn. A browser
 * tab has no device search at all and keeps waiting on the server, as before.
 *
 * On the real hook with the Convex client mocked, because the rule lives
 * between the debounce, the early timer and the `await` on the server.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the early timer never scheduled (no early device answer)             1  (test 1)
 *   the early timer not cleared when the server answers first            1  (test 2)
 *   the early timer not cleared on a new question, and the early draw
 *   not checked against the question it was for                          1  (test 5)
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DeviceSearchAnswer } from "../features/offline/mirrorSearch";

const mockClient = { action: jest.fn<(...args: unknown[]) => Promise<unknown>>() };
const mockEligible = [
  { workspaceId: "ws_alice", slug: "alice", displayName: "Alice" },
  { workspaceId: "ws_team", slug: "team", displayName: "Team" },
];

// One stable value, as Convex's subscription gives: a fresh object per render
// would re-run the search's effect on every state change and restart its timers.
const mockAnswers = { contexts: { eligible: mockEligible, notEligible: [] } };
jest.mock("convex/react", () => ({
  useConvex: () => mockClient,
  useQueries: () => mockAnswers,
}));

import {
  EARLY_DEVICE_MS,
  useBlendedSearch,
  type BlendedDeviceSearch,
  type BlendedSearchView,
} from "../features/console/search/useBlendedSearch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEVICE_NOTICE_PREFIX = "Search could not reach your contexts";

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

function device() {
  const search = jest.fn(async (context: { workspaceId: string }) =>
    found(`device-${context.workspaceId}.md`),
  );
  const value: BlendedDeviceSearch = {
    reachability: "online",
    contexts: CONTEXTS,
    statuses: new Map([
      ["ws_alice", { state: "synced", notes: 5, bytes: 1, lastSyncedAt: 1 }],
      ["ws_team", { state: "synced", notes: 5, bytes: 1, lastSyncedAt: 1 }],
    ]),
    search,
  };
  return { value, search };
}

/** One server page, as `files.searchContexts` answers it. */
function page(...slugs: string[]) {
  return {
    results: slugs.map((slug) => ({
      workspaceId: `ws_${slug}`,
      slug,
      displayName: slug,
      path: `1-projects/${slug}.md`,
      title: slug,
      snippet: "",
    })),
    matchCount: slugs.length,
    matchCountIsFloor: false,
    cursor: null,
    sources: slugs.map((slug) => ({
      workspaceId: `ws_${slug}`,
      slug,
      displayName: slug,
      state: "ok" as const,
      matchCount: 1,
      matchCountIsFloor: false,
    })),
    searchableCount: 2,
  };
}

/** A promise this test settles when it says so. */
function pending() {
  let resolve: (value: unknown) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mount(query: string, local: BlendedDeviceSearch | null) {
  const seen: { current: BlendedSearchView | null } = { current: null };
  const host = document.createElement("div");
  let root: Root | null = null;
  function Probe({ q }: { q: string }) {
    seen.current = useBlendedSearch({ query: q, slugs: [], device: local });
    return null;
  }
  act(() => {
    root = createRoot(host);
    root.render(createElement(Probe, { q: query }));
  });
  return {
    view: () => seen.current as BlendedSearchView,
    retype: (next: string) =>
      act(() => (root as unknown as Root).render(createElement(Probe, { q: next }))),
    unmount: () => act(() => (root as unknown as Root).unmount()),
  };
}

/** Advance the clock and let the promise chains it started run to the end. */
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
}

const DEBOUNCE_MS = 300;

/** The server half of a page: the words wait on `words`, the meaning never lands. */
function serverWaitsOn(words: ReturnType<typeof pending>) {
  mockClient.action.mockImplementation(async (_fn: unknown, args: unknown) =>
    (args as { half?: string }).half === "meaning" ? await new Promise(() => {}) : await words.promise,
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  mockClient.action.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("online with a device copy: the copy answers first", () => {
  test("1. a slow server: device rows at once, no notice, then the server's rows replace them", async () => {
    const words = pending();
    serverWaitsOn(words);
    const local = device();
    const app = mount("review", local.value);

    await advance(DEBOUNCE_MS + EARLY_DEVICE_MS);
    expect(app.view().results.map((row) => row.path)).toEqual([
      "device-ws_alice.md",
      "device-ws_team.md",
    ]);
    expect(app.view().notice).toBeNull();
    expect(app.view().state).toBe("ready");

    await act(async () => {
      words.resolve(page("alice"));
      await Promise.resolve();
    });
    expect(app.view().results.map((row) => row.path)).toEqual(["1-projects/alice.md"]);
    expect(app.view().notice).toBeNull();
    app.unmount();
  });

  test("2. a server that answers inside 400 ms: the device answer is never drawn", async () => {
    mockClient.action.mockImplementation(async (_fn: unknown, args: unknown) => {
      if ((args as { half?: string }).half === "meaning") return await new Promise(() => {});
      await new Promise((done) => setTimeout(done, 100));
      return page("alice");
    });
    const local = device();
    const app = mount("review", local.value);

    await advance(DEBOUNCE_MS + 100);
    expect(app.view().results.map((row) => row.path)).toEqual(["1-projects/alice.md"]);

    await advance(EARLY_DEVICE_MS * 3);
    expect(local.search).not.toHaveBeenCalled();
    expect(app.view().results.map((row) => row.path)).toEqual(["1-projects/alice.md"]);
    expect(app.view().notice).toBeNull();
    app.unmount();
  });

  test("3. a slow server that then fails: the device rows stay, under the unreachable notice", async () => {
    const words = pending();
    serverWaitsOn(words);
    const local = device();
    const app = mount("review", local.value);

    await advance(DEBOUNCE_MS + EARLY_DEVICE_MS);
    expect(app.view().notice).toBeNull();

    await act(async () => {
      words.reject(new Error("network"));
      await Promise.resolve();
    });
    await advance(0);
    expect(app.view().results.map((row) => row.path)).toEqual([
      "device-ws_alice.md",
      "device-ws_team.md",
    ]);
    expect(app.view().notice).toMatch(new RegExp(`^${DEVICE_NOTICE_PREFIX}`));
    expect(app.view().state).toBe("ready");
    app.unmount();
  });

  test("5. a new question typed inside the 400 ms: the old question's device rows are never drawn", async () => {
    const words = pending();
    serverWaitsOn(words);
    const local = device();
    const app = mount("review", local.value);

    // The debounce fires for "review" and its early timer starts; the next
    // letter arrives before the 400 ms are up.
    await advance(DEBOUNCE_MS + 100);
    app.retype("review cycles");

    // The old early timer would have fired by now. The new question's debounce
    // fires and its own early timer has not.
    await advance(DEBOUNCE_MS + 200);
    expect(local.search).not.toHaveBeenCalled();
    expect(app.view().results).toEqual([]);
    expect(app.view().notice).toBeNull();
    app.unmount();
  });
});

describe("online with no device copy: the page waits on the server, as before", () => {
  test("4. the spinner stays up until the server's rows arrive", async () => {
    const words = pending();
    serverWaitsOn(words);
    const app = mount("review", null);

    await advance(DEBOUNCE_MS + 2 * EARLY_DEVICE_MS);
    expect(app.view().state).toBe("searching");
    expect(app.view().results).toEqual([]);

    await act(async () => {
      words.resolve(page("alice"));
      await Promise.resolve();
    });
    expect(app.view().state).toBe("ready");
    expect(app.view().results.map((row) => row.path)).toEqual(["1-projects/alice.md"]);
    expect(app.view().notice).toBeNull();
    app.unmount();
  });
});
