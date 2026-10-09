/**
 * @jest-environment jsdom
 */

/**
 * The map reads its graphs again every two minutes, and every twenty seconds
 * while one is catching up, so "Some recent edits aren't on the map yet"
 * clears by itself rather than staying up until somebody reopens the map.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

let mockBehind = true;
const mockReads: number[] = [];

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    mockReads.push(Date.now());
    return { nodes: [{ path: "a.md", title: "a" }], edges: [], truncated: false, noteCount: 1, linksCut: false, behind: mockBehind, indexMissing: false };
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CATCHING_UP_REFRESH_MS, REFRESH_MS, useMapGraphs, type MapGraphs } from "../features/console/map/live/hooks/useMapGraphs";

const WORKSPACES = [{ id: "ws-refresh", slug: "refresh", displayName: "Refresh", kind: "personal" }];
let root: Root | null = null;
let shown: MapGraphs | null = null;

function Probe() {
  shown = useMapGraphs(WORKSPACES, true);
  return null;
}

async function mount() {
  const host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root!.render(createElement(Probe)));
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockReads.length = 0;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  jest.useRealTimers();
});

describe("how often the map reads its graphs again", () => {
  test("while catching up: every twenty seconds, until it has caught up", async () => {
    mockBehind = true;
    await mount();
    expect(mockReads).toHaveLength(1);
    expect(shown!.partial.behind).toBe(true);
    await advance(CATCHING_UP_REFRESH_MS);
    expect(mockReads).toHaveLength(2);
    // Caught up: the notice goes and the map slows back down.
    mockBehind = false;
    await advance(CATCHING_UP_REFRESH_MS);
    expect(mockReads).toHaveLength(3);
    expect(shown!.partial.behind).toBe(false);
    await advance(CATCHING_UP_REFRESH_MS);
    expect(mockReads).toHaveLength(3);
    await advance(REFRESH_MS);
    expect(mockReads).toHaveLength(4);
  });

  test("otherwise every two minutes", async () => {
    mockBehind = false;
    await mount();
    await advance(REFRESH_MS - 1);
    expect(mockReads).toHaveLength(1);
    await advance(1);
    expect(mockReads).toHaveLength(2);
  });
});
