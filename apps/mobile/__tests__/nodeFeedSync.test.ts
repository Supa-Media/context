/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ManifestPage } from "../features/offline/mirrorSync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A device that keeps a copy catches up when its context's head in the tree's
 * change log moves (`useNodeFeed.ts`), and stops its five-minute pass for a
 * context the feed reaches (phase 6 of the Convex tree).
 *
 * Sabotage: dropping the `feedKey` effect fails "a head that moves is a pass";
 * dropping the `fedRef` check in `tick` fails "no timed pass while fed".
 */

jest.mock("../features/offline/mirrorStore", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { memoryMirrorStore } = require("../features/offline/mirrorStoreCore");
  const store = memoryMirrorStore();
  return { openMirrorStore: async () => store, mirrorSupported: () => true };
});
jest.mock("../features/offline/reachability", () => ({
  useReachability: () => "online",
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { useMirrorSync, MIRROR_INTERVAL_MS } = require("../features/offline/useMirrorSync") as typeof import("../features/offline/useMirrorSync");
/* eslint-enable @typescript-eslint/no-require-imports */

async function settle(rounds = 40) {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

let walks = 0;
const actions = {
  syncManifest: async (): Promise<ManifestPage> => {
    walks += 1;
    return { entries: [], folders: [{ path: "", visibility: "private" }], cursor: null, truncated: false, manifestUsable: true };
  },
  readNotes: async () => ({ results: [] }),
};
const contexts = [{ workspaceId: "w1", role: "owner" }];

beforeEach(() => {
  walks = 0;
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick", "setImmediate"] });
});
afterEach(() => {
  jest.useRealTimers();
});

async function mount(feed: () => ReadonlyMap<string, string> | undefined) {
  function Harness() {
    useMirrorSync({ contexts, actions, feed: feed() });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  await settle();
  return {
    rerender: async () => {
      await act(async () => root.render(createElement(Harness)));
      await settle();
    },
    unmount: async () => act(async () => root.unmount()),
  };
}

describe("the feed drives the device copy", () => {
  test("a head that moves is a pass; one that stays is not", async () => {
    let feed = new Map([["w1", "nodes:e1|1"]]);
    const harness = await mount(() => feed);
    const afterMount = walks;
    expect(afterMount).toBeGreaterThan(0);
    await harness.rerender();
    expect(walks).toBe(afterMount);
    feed = new Map([["w1", "nodes:e1|2"]]);
    await harness.rerender();
    expect(walks).toBeGreaterThan(afterMount);
    await harness.unmount();
  });

  test("no timed pass while every context is fed; the timed pass stays for one that is not", async () => {
    let feed: ReadonlyMap<string, string> = new Map([["w1", "nodes:e1|1"]]);
    const harness = await mount(() => feed);
    const settled = walks;
    await act(async () => {
      jest.advanceTimersByTime(MIRROR_INTERVAL_MS + 1);
    });
    await settle();
    expect(walks).toBe(settled);

    feed = new Map();
    await harness.rerender();
    const unfed = walks;
    await act(async () => {
      jest.advanceTimersByTime(MIRROR_INTERVAL_MS + 1);
    });
    await settle();
    expect(walks).toBeGreaterThan(unfed);
    await harness.unmount();
  });
});
