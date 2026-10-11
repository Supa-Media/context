/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The desktop and phone apps keep a copy of each workspace, and their walk of
 * its tree asks for the tree table by name, as a browser tab's does. Before
 * this, only a tab asked, so the apps walked the bucket every time and nothing
 * they did ever started the table filling (2026-10-08).
 *
 * Sabotage: dropping `source: "tree"` from the engine's manifest call fails it.
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
const { useMirrorSync } = require("../features/offline/useMirrorSync") as typeof import("../features/offline/useMirrorSync");
/* eslint-enable @typescript-eslint/no-require-imports */

async function settle(rounds = 60) {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

describe("an app's copy of a workspace", () => {
  test("walks the tree table, not the bucket", async () => {
    const calls: { source?: string }[] = [];
    const actions = {
      syncManifest: async (args: { workspaceId: string; cursor?: string; source?: "tree" }) => {
        calls.push({ source: args.source });
        return {
          entries: [],
          folders: [{ path: "", visibility: "private" as const }],
          cursor: null,
          truncated: false,
          manifestUsable: true,
          source: "tree" as const,
        };
      },
      readNotes: async () => ({ results: [] }),
    };
    const contexts = [{ workspaceId: "w1", role: "owner" }];
    function Harness() {
      useMirrorSync({ contexts, actions });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Harness)));
    await settle();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.source === "tree")).toBe(true);
    await act(async () => root.unmount());
  });
});
