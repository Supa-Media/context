/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";
import type { MirrorStore } from "../features/offline/mirrorStoreCore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The file tree is drawn from metadata the device already holds, and kept
 * current by the mirror's walks — not by asking the bucket folder by folder.
 *
 * Through the real `useFileBrowser`, with the in-memory mirror standing in for
 * IndexedDB. Each property below fails when its rule is removed
 * (sabotage-checked while writing):
 *
 *  - **folders open without a request** — drawing only the root from the
 *    device fails "a nested folder opens from the tree without asking the
 *    bucket".
 *  - **cached rows before the network** — gating the device's tree on the
 *    root request fails "a reload draws the tree before the bucket answers".
 *  - **another writer's folder appears** — not redrawing on a committed walk
 *    fails "a folder somebody else made appears without a reload".
 *  - **a newer live listing wins** — replacing a folder regardless of when its
 *    own listing started fails "a walk older than a live listing does not
 *    undo it".
 *  - **a refusal takes the tree down** — keeping device rows after the root
 *    is refused fails "a refused context shows none of the device's tree".
 */

let mockMirror: MirrorStore;
jest.mock("../features/offline/mirrorStore", () => ({
  openMirrorStore: async () => mockMirror,
}));

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { useFileBrowser } =
  require("../features/console/files/useFileBrowser") as typeof import("../features/console/files/useFileBrowser");
const { memoryMirrorStore } =
  require("../features/offline/mirrorStoreCore") as typeof import("../features/offline/mirrorStoreCore");
const { refreshMetadata } =
  require("../features/offline/mirrorSync") as typeof import("../features/offline/mirrorSync");
const { currentEpoch } =
  require("../features/offline/epoch") as typeof import("../features/offline/epoch");
const events =
  require("../features/offline/mirrorEvents") as typeof import("../features/offline/mirrorEvents");
const { announceBucketWrite } =
  require("../features/console/files/bucketWrites") as typeof import("../features/console/files/bucketWrites");
/* eslint-enable @typescript-eslint/no-require-imports */

const W = "w1";

/** The bucket: every path, and the folders it holds with nothing in them. */
let paths: string[];
let emptyFolders: string[];
let listCalls: string[];
let browser: FileBrowser;
let refreshRequests: string[];
let stopListening: (() => void) | null = null;

async function settle(rounds = 20) {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function allFolders(): Set<string> {
  const folders = new Set<string>([""]);
  for (const path of [...paths, ...emptyFolders.map((folder) => `${folder}/x`)]) {
    let at = folderOf(path);
    while (at !== "") {
      folders.add(at);
      at = folderOf(at);
    }
  }
  return folders;
}

/** What `listFiles` answers for one folder of the fake bucket. */
function listingOf(folder: string): FolderListing {
  const prefix = folder === "" ? "" : `${folder}/`;
  const row = (kind: "file" | "folder", path: string) => ({
    kind,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly: false,
  });
  const subfolders = [...allFolders()].filter((each) => each !== "" && folderOf(each) === folder);
  const files = paths.filter((path) => path.startsWith(prefix) && folderOf(path) === folder);
  return {
    path: folder,
    folderDefault: "private",
    entries: [...subfolders.sort().map((path) => row("folder", path)), ...files.sort().map((path) => row("file", path))],
    truncated: false,
    manifestUsable: true,
  };
}

/** One metadata walk of the fake bucket, committed and announced as the sync hook does. */
async function walk() {
  const epoch = currentEpoch();
  await act(async () => {
    await refreshMetadata(
      {
        store: mockMirror,
        epoch,
        mine: () => epoch === currentEpoch(),
        now: () => Date.now(),
        needed: async () => () => new Set(),
        manifest: async () => ({
          entries: paths.map((path) => ({
            path,
            etag: `e:${path}`,
            visibility: "private" as const,
            inherited: "private" as const,
            exception: false,
            readOnly: false,
          })),
          folders: [...allFolders()].map((path) => ({ path, visibility: "private" as const })),
          cursor: null,
          truncated: false,
          manifestUsable: true,
        }),
        readNotes: async () => [],
        onListed: (workspaceId) => events.publishMirrorListed(workspaceId),
      },
      { workspaceId: W, tier: "private" },
    );
  });
  await settle();
}

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: W, tier: "private", canEdit: true });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

const fn = (name: string) => `functions/files:${name}`;
let unmount: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  mockMirror = memoryMirrorStore();
  paths = ["index.md", "1-projects/pilot.md", "1-projects/deep/nested/plan.md"];
  emptyFolders = [];
  listCalls = [];
  refreshRequests = [];
  stopListening = events.onMirrorRefreshRequest((workspaceId) => refreshRequests.push(workspaceId));
  actions[fn("listFiles")] = async (args: never) => {
    const { path } = args as unknown as { path: string };
    listCalls.push(path);
    return listingOf(path);
  };
  actions[fn("notePaths")] = async () => ({ paths });
});

afterEach(() => {
  unmount?.();
  unmount = null;
  stopListening?.();
});

describe("the tree is drawn from metadata the device holds", () => {
  test("opening a context asks the mirror for a fresh walk of it", async () => {
    unmount = mount();
    await settle();
    expect(refreshRequests).toEqual([W]);
  });

  test("a reload draws the tree before the bucket answers", async () => {
    await walk();
    let answerRoot: (listing: FolderListing) => void = () => {};
    actions[fn("listFiles")] = (args: never) => {
      listCalls.push((args as unknown as { path: string }).path);
      return new Promise((resolve) => {
        answerRoot = resolve as (listing: FolderListing) => void;
      });
    };
    unmount = mount();
    await settle();
    expect(browser.loading).toBe(false);
    expect(browser.listings[""]?.entries.map((entry) => entry.path)).toEqual(["1-projects", "index.md"]);
    answerRoot(listingOf(""));
    await settle();
    expect(browser.listings[""]?.entries.map((entry) => entry.path)).toEqual(["1-projects", "index.md"]);
  });

  test("a nested folder opens from the tree without asking the bucket", async () => {
    await walk();
    unmount = mount();
    await settle();
    listCalls = [];
    act(() => browser.toggleFolder("1-projects"));
    act(() => browser.toggleFolder("1-projects/deep"));
    act(() => browser.toggleFolder("1-projects/deep/nested"));
    await settle();
    expect(listCalls).toEqual([]);
    expect(browser.listings["1-projects/deep/nested"]?.entries.map((entry) => entry.path)).toEqual([
      "1-projects/deep/nested/plan.md",
    ]);
  });

  test("a folder somebody else made appears without a reload, and what was open stays open", async () => {
    await walk();
    unmount = mount();
    await settle();
    act(() => browser.toggleFolder("1-projects"));
    await settle();

    // Another person makes a nested note in a brand new folder, and an empty folder.
    paths.push("1-projects/launch/brief.md");
    emptyFolders.push("1-projects/later");
    await walk();

    expect(browser.expanded.has("1-projects")).toBe(true);
    expect(browser.listings["1-projects"]?.entries.map((entry) => entry.path)).toEqual([
      "1-projects/deep",
      "1-projects/later",
      "1-projects/launch",
      "1-projects/pilot.md",
    ]);
    expect(browser.listings["1-projects/launch"]?.entries.map((entry) => entry.path)).toEqual([
      "1-projects/launch/brief.md",
    ]);
    expect(browser.listings["1-projects/later"]?.entries).toEqual([]);
  });

  test("a folder deleted elsewhere leaves the tree on the next complete walk", async () => {
    await walk();
    unmount = mount();
    await settle();
    paths = paths.filter((path) => !path.startsWith("1-projects/deep/"));
    await walk();
    expect(browser.listings["1-projects/deep"]).toBeUndefined();
    expect(browser.listings["1-projects"]?.entries.map((entry) => entry.path)).toEqual([
      "1-projects/pilot.md",
    ]);
  });

  test("a walk older than a live listing does not undo it", async () => {
    const realNow = Date.now;
    const at = (ms: number) => {
      Date.now = () => ms;
    };
    const t0 = realNow();
    try {
      at(t0 - 120_000);
      await walk();
      at(t0);
      unmount = mount();
      await settle();
      // This console writes a note and relists its folder, at t0.
      paths.push("1-projects/new.md");
      act(() => announceBucketWrite({ workspaceId: W, path: "1-projects/new.md" }));
      await settle();
      expect(browser.listings["1-projects"]?.entries.map((entry) => entry.path)).toContain(
        "1-projects/new.md",
      );
      // A walk that started a minute before that listing lands after it, and
      // did not see the note.
      paths = paths.filter((path) => path !== "1-projects/new.md");
      at(t0 - 60_000);
      await walk();
    } finally {
      Date.now = realNow;
    }
    expect(browser.listings["1-projects"]?.entries.map((entry) => entry.path)).toContain(
      "1-projects/new.md",
    );
  });

  test("a refused context shows none of the device's tree", async () => {
    await walk();
    let refuse: () => void = () => {};
    actions[fn("listFiles")] = () =>
      new Promise((_, reject) => {
        refuse = () =>
          reject(new ConvexError({ code: "FORBIDDEN", message: "You are no longer a member of this context." }));
      });
    unmount = mount();
    await settle();
    // The device drew its tree while the bucket was being asked...
    expect(browser.listings["1-projects"]).toBeDefined();
    // ...and the refusal takes all of it down.
    refuse();
    await settle(40);
    expect(browser.listings).toEqual({});
    expect(browser.notice).toBe("You are no longer a member of this context.");
  });

  test("a refused folder takes its device rows down with it", async () => {
    await walk();
    unmount = mount();
    await settle();
    expect(browser.listings["1-projects/deep"]).toBeDefined();
    actions[fn("listFiles")] = async () => {
      throw new ConvexError({ code: "FORBIDDEN", message: "You can no longer see this folder." });
    };
    act(() => announceBucketWrite({ workspaceId: W, path: "1-projects/deep/x.md" }));
    await settle();
    expect(browser.listings["1-projects/deep"]).toBeUndefined();
  });
});
