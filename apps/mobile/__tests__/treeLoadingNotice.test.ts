/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * "Still loading": what the console shows while a workspace's first copy into
 * the Convex tree has not finished. Nothing lists the bucket in its place
 * (decided by the owner, 2026-10-13), so the root listing answers
 * `TREE_LOADING` and the console says so, and the live root listing replaces
 * that line the moment the tree serves. The harness is
 * `fileBrowserGuards.test.ts`'s, with a live root the test can land.
 *
 * Sabotage: drop the notice clear in `useListings`' `commitLive` and the
 * second case fails (the "still loading" line stays over a drawn tree).
 */

const MOCK_LOADING = "This workspace's files are still loading. They will appear here in a minute.";
const mockCalls: string[] = [];
let mockLiveRoot: FolderListing | null = null;
const mockRerenders = new Set<() => void>();

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const { ConvexError: Refusal } = require("convex/values") as typeof import("convex/values");
  const { useEffect, useState } = require("react") as typeof import("react");
  const bound: Record<string, () => Promise<unknown>> = {};
  // One function per action, as `useAction` keeps: a fresh one each render re-runs every effect keyed on it.
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= async () => {
      mockCalls.push(name);
      if (name === "functions/files:listFiles") throw new Refusal({ code: "TREE_LOADING", message: MOCK_LOADING });
      return null;
    };
    return bound[name];
  };
  return {
    useAction: record,
    useMutation: record,
    useQuery: () => undefined,
    useQueries: (spec: Record<string, unknown>) => {
      const [, bump] = useState(0);
      useEffect(() => {
        const rerender = () => bump((n: number) => n + 1);
        mockRerenders.add(rerender);
        return () => void mockRerenders.delete(rerender);
      }, []);
      return "f:" in spec ? { "f:": mockLiveRoot } : {};
    },
    useConvex: () => ({ query: async () => mockLiveRoot }),
  };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => await Promise.resolve());
}

const ROOT: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [{ kind: "file", path: "index.md", name: "index.md", visibility: "private", inherited: "private", exception: false, readOnly: false }],
  truncated: false,
  manifestUsable: true,
};

describe("a workspace whose tree is still loading", () => {
  let unmount: (() => void) | null = null;
  afterEach(() => {
    unmount?.();
    unmount = null;
    mockLiveRoot = null;
    mockCalls.length = 0;
  });

  test("says so, rather than list anything from the bucket", async () => {
    unmount = mount();
    await settle();
    expect(mockCalls).toContain("functions/files:listFiles");
    expect(browser.notice).toBe(MOCK_LOADING);
    expect(browser.listings[""]).toBeUndefined();
  });

  test("the live root listing replaces the line the moment the tree serves", async () => {
    unmount = mount();
    await settle();
    expect(browser.notice).toBe(MOCK_LOADING);
    mockLiveRoot = ROOT;
    act(() => {
      for (const rerender of mockRerenders) rerender();
    });
    await settle();
    expect(browser.listings[""]?.entries.map((entry) => entry.path)).toEqual(["index.md"]);
    expect(browser.notice).toBeNull();
  });
});


