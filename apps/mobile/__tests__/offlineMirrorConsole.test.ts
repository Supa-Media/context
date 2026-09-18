/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";
import type { MirrorStore } from "../features/offline/mirrorStoreCore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The mirror, through the real console: the file browser reading from it,
 * writing to it, and — the property this whole feature must not cost — a
 * queued edit that still gets a real Merge after a sync has moved the note on.
 *
 * jsdom has no IndexedDB, so every other console test runs with no mirror and
 * exercises the bounded cache, which is still what a browser without one gets.
 * This file swaps in the in-memory mirror so the same hook runs the mirror's
 * half. Sabotage-checked, each failing "a queued edit still gets a real merge
 * after a sync moved the note on": ignoring the in-memory holds
 * (`mirrorHolds`) — the queue is not written down yet when the sync runs, so
 * only the hold knows; answering "nothing needed" at all; dropping the
 * ancestor rule in `mirror.ts`; and having `rememberNote` write without asking
 * what is needed. The last three also fail "an online reopen keeps the
 * ancestor a parked write needs", which is the read cache's own older loss.
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
const { syncContext } =
  require("../features/offline/mirrorSync") as typeof import("../features/offline/mirrorSync");
const { neededEtags } =
  require("../features/offline/mirrorHolds") as typeof import("../features/offline/mirrorHolds");
const { openStore } =
  require("../features/offline/store") as typeof import("../features/offline/store");
const { currentEpoch } =
  require("../features/offline/epoch") as typeof import("../features/offline/epoch");
const mirror = require("../features/offline/mirror") as typeof import("../features/offline/mirror");
/* eslint-enable @typescript-eslint/no-require-imports */

const W = "w1";
const PATH = "1-projects/pilot.md";
const OTHER = "2-areas/deep/never-opened.md";

const BASE = "# Pilot\n\nOne.\n\nTwo.\n\nThree.\n";
const MINE = "# Pilot\n\nOne, from the train.\n\nTwo.\n\nThree.\n";
const THEIRS = "# Pilot\n\nOne.\n\nTwo.\n\nThree, corrected.\n";
const MERGED = "# Pilot\n\nOne, from the train.\n\nTwo.\n\nThree, corrected.\n";

function noteAt(path: string, text: string, etag: string): OpenNote {
  return {
    path,
    text,
    etag,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

/** The bucket, by path. */
let bucket: Map<string, OpenNote>;
let writes: { path: string; expectedEtag?: string }[];
let browser: FileBrowser;
let online = true;

function setOnline(value: boolean): void {
  online = value;
  Object.defineProperty(window.navigator, "onLine", { get: () => online, configurable: true });
  act(() => {
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
}

async function settle(rounds = 12) {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

function rootListing(): FolderListing {
  return {
    path: "",
    folderDefault: "private",
    entries: [...new Set([...bucket.keys()].map((path) => path.split("/")[0]!))].map((top) => ({
      kind: "folder" as const,
      path: top,
      name: top,
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    })),
    truncated: false,
    manifestUsable: true,
  };
}

/** One sync of `W`, driven from the fake bucket, with the console's real `needed`. */
async function syncNow() {
  const epoch = currentEpoch();
  await act(async () => {
    await syncContext(
      {
        store: mockMirror,
        epoch,
        mine: () => epoch === currentEpoch(),
        now: () => Date.now(),
        needed: (workspaceId) => neededEtags(openStore(), workspaceId),
        manifest: async () => ({
          entries: [...bucket.values()].map((note) => ({
            path: note.path,
            etag: note.etag,
            visibility: note.visibility,
            inherited: note.inherited,
            exception: false,
            readOnly: false,
          })),
          cursor: null,
          truncated: false,
          manifestUsable: true,
        }),
        readNotes: async (_workspaceId, paths) =>
          paths.map((path) => {
            const found = bucket.get(path);
            return found === undefined
              ? { path, outcome: "error" as const, code: "FILE_NOT_FOUND", message: "gone" }
              : { path, outcome: "read" as const, note: found };
          }),
      },
      { workspaceId: W, tier: "private" },
    );
  });
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
  writes = [];
  bucket = new Map([
    [PATH, noteAt(PATH, BASE, "e1")],
    [OTHER, noteAt(OTHER, "Nobody opened this on this device.\n", "o1")],
  ]);
  setOnline(true);
  actions[fn("listFiles")] = async () => rootListing();
  actions[fn("notePaths")] = async () => ({ paths: [...bucket.keys()] });
  actions[fn("readNote")] = async (args: never) => {
    const { path } = args as unknown as { path: string };
    const found = bucket.get(path);
    if (found === undefined) throw new ConvexError({ code: "FILE_NOT_FOUND", message: "gone" });
    return found;
  };
  actions[fn("writeNote")] = async (args: never) => {
    const write = args as unknown as { path: string; text: string; expectedEtag?: string };
    writes.push({ path: write.path, expectedEtag: write.expectedEtag });
    const current = bucket.get(write.path);
    if (write.expectedEtag !== current?.etag) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "That file changed somewhere else while you were editing it.",
        currentEtag: current?.etag,
      });
    }
    const etag = `${current!.etag}+`;
    bucket.set(write.path, noteAt(write.path, write.text, etag));
    return { path: write.path, etag, conflictCheck: "conditional" };
  };
  unmount = mount();
});

afterEach(() => {
  unmount?.();
  unmount = null;
  setOnline(true);
});

describe("the console reads the mirror", () => {
  test("offline, a note nobody opened on this device opens from the mirror", async () => {
    await settle();
    await syncNow();
    setOnline(false);
    browser.select(OTHER);
    await settle();
    expect(browser.editor.path).toBe(OTHER);
    expect(browser.editor.draft).toBe("Nobody opened this on this device.\n");
  });

  test("offline, a folder nobody expanded lists from the mirror", async () => {
    await settle();
    await syncNow();
    setOnline(false);
    browser.toggleFolder("2-areas/deep");
    await settle();
    expect(browser.listings["2-areas/deep"]?.entries.map((entry) => entry.path)).toEqual([OTHER]);
  });

  test("an online open lands in the mirror, and so does a save", async () => {
    await settle();
    browser.select(PATH);
    await settle();
    expect((await mirror.mirroredNote(mockMirror, "private", W, PATH))?.value.etag).toBe("e1");
    browser.setDraft(MINE);
    await settle();
    browser.save();
    await settle(40);
    expect(writes).toEqual([{ path: PATH, expectedEtag: "e1" }]);
    const saved = await mirror.mirroredNote(mockMirror, "private", W, PATH);
    expect(saved?.value.text).toBe(MINE);
    expect(saved?.value.etag).toBe("e1+");
  });
});

describe("never losing the merge", () => {
  test("a queued edit still gets a real merge after a sync moved the note on", async () => {
    await settle();
    browser.select(PATH);
    await settle();

    // On the train: typed and saved against e1, so it is queued.
    setOnline(false);
    browser.setDraft(MINE);
    await settle();
    browser.save();
    await settle();
    expect(browser.editor.status).toBe("queued");

    // Meanwhile somebody's Obsidian writes e2, and a sync pulls it down —
    // the ordinary reconnection order is a sync and a drain in either order.
    bucket.set(PATH, noteAt(PATH, THEIRS, "e2"));
    await syncNow();
    expect((await mirror.mirroredNote(mockMirror, "private", W, PATH))?.value.etag).toBe("e2");

    // Back online: the drain sends against e1 and is refused.
    setOnline(true);
    await settle(30);
    expect(writes.at(-1)).toEqual({ path: PATH, expectedEtag: "e1" });

    // Reopening the note restores the parked write as a conflict…
    browser.select(PATH);
    await settle(30);
    expect(browser.editor.status).toBe("conflict");
    const review = browser.conflict!;
    expect(review.theirs).toBe(THEIRS);
    // …and the merge is real: made against the version the edit was typed on.
    expect(review.mergeRefusal).toBeNull();
    expect(review.merge?.text).toBe(MERGED);
  });

  test("an online reopen keeps the ancestor a parked write needs", async () => {
    await settle();
    browser.select(PATH);
    await settle();
    setOnline(false);
    browser.setDraft(MINE);
    await settle();
    browser.save();
    await settle();

    // No sync at all this time: the reopen itself is what used to overwrite
    // the only copy of e1 with the bucket's e2.
    bucket.set(PATH, noteAt(PATH, THEIRS, "e2"));
    setOnline(true);
    await settle(30);
    browser.select(PATH);
    await settle(30);
    expect(browser.editor.status).toBe("conflict");
    expect(browser.conflict?.merge?.text).toBe(MERGED);
  });
});

describe("the old read cache, and plaintext a lock revokes", () => {
  test("copies the bounded cache held are handed to the mirror and retired", async () => {
    unmount?.();
    const cache = require("../features/offline/cache") as typeof import("../features/offline/cache");
    const kv = openStore();
    // Read before the upgrade: the ancestor of whatever was queued against e1.
    await cache.putNote(kv, "private", W, noteAt(PATH, BASE, "e1"), 5);
    unmount = mount();
    await settle(40);
    expect((await mirror.mirroredNote(mockMirror, "private", W, PATH))?.value.text).toBe(BASE);
    expect(await cache.getNote(kv, "private", W, PATH)).toBeNull();
  });

  test("a note locked on this device leaves the mirror, ancestor and all", async () => {
    await settle();
    await syncNow();
    const epoch = currentEpoch();
    // An ancestor held for a parked write, so both slots have plaintext.
    await mirror.putMirroredNotes(
      mockMirror,
      epoch,
      "private",
      W,
      [noteAt(PATH, THEIRS, "e2")],
      () => new Set(["e1"]),
      Date.now(),
    );
    expect(await mockMirror.readBody("private", W, "base", PATH)).not.toBeNull();
    browser.discardLocalCopies(PATH);
    await settle(40);
    expect(await mirror.mirroredNote(mockMirror, "private", W, PATH)).toBeNull();
    expect(await mockMirror.readBody("private", W, "current", PATH)).toBeNull();
    expect(await mockMirror.readBody("private", W, "base", PATH)).toBeNull();
  });
});

describe("a context never synced", () => {
  test("offline with nothing mirrored still says to open it once with a connection", async () => {
    unmount?.();
    mockMirror = memoryMirrorStore();
    setOnline(false);
    unmount = mount();
    await settle();
    expect(browser.notice).toContain("Open it once with a connection");
  });
});
