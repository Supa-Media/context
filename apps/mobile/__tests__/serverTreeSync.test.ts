/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ManifestPage } from "../features/offline/mirrorSync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A plain browser tab has no mirror, and the request to re-list a context —
 * opening it, or the tree signal saying somebody changed it — walks the
 * server's manifest into memory and tells the tree. Before this, the request
 * reached a mirror that was not there and nothing happened: folders loaded one
 * request at a time, and another writer's changes never appeared (2026-10-08).
 *
 * Sabotage: returning early when `openMirrorStore` gives `null` (the old code)
 * fails "a refresh request walks the server and redraws the tree".
 */

jest.mock("../features/offline/mirrorStore", () => ({
  openMirrorStore: async () => null,
  mirrorSupported: () => false,
}));
jest.mock("../features/offline/reachability", () => ({
  useReachability: () => "online",
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { useMirrorSync } = require("../features/offline/useMirrorSync") as typeof import("../features/offline/useMirrorSync");
const events = require("../features/offline/mirrorEvents") as typeof import("../features/offline/mirrorEvents");
const { serverTree, forgetServerTrees } = require("../features/offline/serverTree") as typeof import("../features/offline/serverTree");
const { currentEpoch } = require("../features/offline/epoch") as typeof import("../features/offline/epoch");
/* eslint-enable @typescript-eslint/no-require-imports */

async function settle(rounds = 30) {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

afterEach(() => forgetServerTrees());

describe("a browser tab's tree", () => {
  test("a refresh request walks the server and redraws the tree, holding nothing on the device", async () => {
    const manifestCalls: (string | undefined)[] = [];
    const page = (cursor: string | undefined): ManifestPage =>
      cursor === undefined
        ? {
            entries: [
              { path: "0-inbox/google-chat/a.md", etag: "1", visibility: "private", inherited: "private", exception: false, readOnly: false },
            ],
            folders: [{ path: "", visibility: "private" }, { path: "0-inbox", visibility: "private" }, { path: "0-inbox/google-chat", visibility: "private" }],
            cursor: "0-inbox/google-chat/a.md",
            truncated: false,
            manifestUsable: true,
          }
        : {
            entries: [
              { path: "todo.md", etag: "2", visibility: "private", inherited: "private", exception: false, readOnly: false },
            ],
            folders: [{ path: "", visibility: "private" }],
            cursor: null,
            truncated: false,
            manifestUsable: true,
          };
    const actions = {
      syncManifest: async (args: { workspaceId: string; cursor?: string }) => {
        manifestCalls.push(args.cursor);
        return page(args.cursor);
      },
      readNotes: async () => {
        throw new Error("a browser tab reads no bodies for its tree");
      },
    };
    const contexts = [{ workspaceId: "w1", role: "owner" }];
    function Harness() {
      useMirrorSync({ contexts, actions });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Harness)));
    await settle();

    const listed: string[] = [];
    const stop = events.onMirrorListed((workspaceId) => listed.push(workspaceId));
    await act(async () => events.requestMirrorRefresh("w1"));
    await settle();
    stop();

    expect(manifestCalls).toEqual([undefined, "0-inbox/google-chat/a.md"]);
    expect(listed).toEqual(["w1"]);
    const tree = serverTree("private", "w1", currentEpoch())!;
    expect(tree.value.get("0-inbox/google-chat")!.entries.map((e) => e.path)).toEqual(["0-inbox/google-chat/a.md"]);
    expect(tree.value.get("")!.entries.map((e) => e.path)).toEqual(["0-inbox", "todo.md"]);
    await act(async () => root.unmount());
  });

  test("a context opened before the context list landed is walked once it does", async () => {
    const calls: string[] = [];
    const actions = {
      syncManifest: async (args: { workspaceId: string; cursor?: string }): Promise<ManifestPage> => {
        calls.push(args.workspaceId);
        return { entries: [], folders: [{ path: "", visibility: "private" }], cursor: null, truncated: false, manifestUsable: true };
      },
      readNotes: async () => ({ results: [] }),
    };
    let contexts: { workspaceId: string; role: string }[] | undefined;
    function Harness() {
      useMirrorSync({ contexts, actions });
      return null;
    }
    // The console asks before the sync hook is even listening.
    events.requestMirrorRefresh("w2");
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Harness)));
    await settle();
    expect(calls).toEqual([]);
    contexts = [{ workspaceId: "w2", role: "owner" }];
    await act(async () => root.render(createElement(Harness)));
    await settle();
    expect(calls).toEqual(["w2"]);
    expect(serverTree("private", "w2", currentEpoch())).not.toBeNull();
    await act(async () => root.unmount());
  });
});
