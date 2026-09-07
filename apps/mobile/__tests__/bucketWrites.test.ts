/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **A folder somebody else wrote into does not stay as it was.**
 *
 * The console refreshes a folder whenever *it* writes into one. A meeting is
 * the first write in this product that reaches the same bucket from outside the
 * file browser, and it went unannounced: the note was in the customer's bucket
 * and the phone that had already read that folder kept showing a listing
 * without it, while a client that had never read the folder showed it
 * immediately. That asymmetry is the whole of the bug report — "it did not show
 * up on the mobile app, but it showed up on the web app" — and it is why the
 * assertions below are about the *listing the console would draw*, never about
 * a flag.
 *
 * Two halves, and they fail separately: the bus does what it says
 * (`bucketWrites.ts`), and the browser is actually listening.
 */

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

import { announceBucketWrite, onBucketWrite } from "../features/console/files/bucketWrites";
import { useFileBrowser } from "../features/console/files/useFileBrowser";
import { writeNoteThrough } from "../features/meetings/convexGateway";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const MEETING = "0-inbox/meetings/2026-09-07-standup-a1b2c3d4.md";

function name(fn: string): string {
  return `functions/files:${fn}`;
}

/** A listing of `0-inbox/meetings`, holding whatever it is given. */
function listing(path: string, names: readonly string[]): FolderListing {
  return {
    path,
    folderDefault: "private",
    entries: names.map((leaf) => ({
      kind: "file" as const,
      path: `${path}/${leaf}`,
      name: leaf,
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    })),
    truncated: false,
    manifestUsable: true,
  };
}

const EMPTY_ROOT: FolderListing = { ...listing("", []), folderDefault: "private" };

/** What the bucket answers right now. Reassigned mid-test, as a bucket is. */
let onDisk: Record<string, FolderListing> = {};

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    browser = useFileBrowser({ workspaceId: WORKSPACE, canEdit: true, tier: "private" });
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The names the console would draw for a folder it is holding. */
function drawn(folder: string): string[] {
  return (browser.listings[folder]?.entries ?? []).map((entry) => entry.name);
}

let unmount: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  onDisk = { "": EMPTY_ROOT, "0-inbox/meetings": listing("0-inbox/meetings", []) };
  actions[name("listFiles")] = async (args: never) => {
    const { path } = args as unknown as { path: string };
    return onDisk[path] ?? listing(path, []);
  };
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

/* -------------------------------------------------------------------------- */

describe("the bus", () => {
  test("a subscriber hears a write, and stops hearing after it unsubscribes", () => {
    const heard: string[] = [];
    const off = onBucketWrite((write) => heard.push(write.path));

    announceBucketWrite({ workspaceId: WORKSPACE, path: MEETING });
    off();
    announceBucketWrite({ workspaceId: WORKSPACE, path: "1-projects/other.md" });

    expect(heard).toEqual([MEETING]);
  });

  test("nothing is replayed to somebody who subscribes afterwards", () => {
    // A console that mounts after the write reads the folder fresh on the way
    // in. Replaying would make it reload a folder it has just loaded.
    announceBucketWrite({ workspaceId: WORKSPACE, path: MEETING });
    const heard: string[] = [];
    const off = onBucketWrite((write) => heard.push(write.path));
    expect(heard).toEqual([]);
    off();
  });

  test("a listener that throws does not take the writer down with it", () => {
    /*
      The announcement happens after the note is already in the bucket. A
      subscriber failing there must cost a stale listing — the state this whole
      file exists to improve — and never the write's own return path.
    */
    const heard: string[] = [];
    const offBad = onBucketWrite(() => {
      throw new Error("subscriber is broken");
    });
    const offGood = onBucketWrite((write) => heard.push(write.path));

    expect(() => announceBucketWrite({ workspaceId: WORKSPACE, path: MEETING })).not.toThrow();
    // And the one after the thrower still hears it.
    expect(heard).toEqual([MEETING]);
    offBad();
    offGood();
  });
});

describe("the console listening to it", () => {
  /**
   * SABOTAGE: delete the `onBucketWrite` effect in `useFileBrowser`. Fails
   * here and nowhere else.
   */
  test("a meeting landing in a folder the console is holding reloads that folder", async () => {
    unmount = mount();
    await settle();

    // The console has read the folder, and it is empty.
    await act(async () => {
      browser.select("0-inbox/meetings");
    });
    await settle();
    expect(drawn("0-inbox/meetings")).toEqual([]);

    // A meeting lands in it, written by something that is not this browser.
    onDisk["0-inbox/meetings"] = listing("0-inbox/meetings", [
      "2026-09-07-standup-a1b2c3d4.md",
    ]);
    await act(async () => {
      announceBucketWrite({ workspaceId: WORKSPACE, path: MEETING });
    });
    await settle();

    expect(drawn("0-inbox/meetings")).toEqual(["2026-09-07-standup-a1b2c3d4.md"]);
  });

  /**
   * The first meeting anybody records, now that the default destination is
   * `0-inbox/meetings`: the folder does not exist, so the write creates it, and
   * the listing the person is looking at is the one *above* it.
   *
   * The parent-only version of this effect fixed the second meeting and none of
   * the first, which is the same symptom one level up.
   *
   * SABOTAGE: `["", ...ancestorsOf(write.path)]` → `[parent]`. Fails here.
   */
  test("a meeting creating its folder refreshes the folder above it too", async () => {
    onDisk = { "": listing("", []), "0-inbox": listing("0-inbox", []) };
    unmount = mount();
    await settle();

    // The person is standing in `0-inbox`, which has nothing in it.
    await act(async () => {
      browser.select("0-inbox");
    });
    await settle();
    expect(drawn("0-inbox")).toEqual([]);

    // The meeting lands in a folder that did not exist until this write.
    onDisk["0-inbox"] = listing("0-inbox", ["meetings"]);
    onDisk["0-inbox/meetings"] = listing("0-inbox/meetings", [
      "2026-09-07-standup-a1b2c3d4.md",
    ]);
    await act(async () => {
      announceBucketWrite({ workspaceId: WORKSPACE, path: MEETING });
    });
    await settle();

    expect(drawn("0-inbox")).toEqual(["meetings"]);
  });

  test("...and the root, when the new folder is a top-level one", async () => {
    // `ancestorsOf` never yields `""`, so the root is the ancestor a plain
    // walk misses — and it is the listing a phone lands on.
    onDisk = { "": listing("", []) };
    unmount = mount();
    await settle();
    expect(drawn("")).toEqual([]);

    onDisk[""] = listing("", ["meetings"]);
    await act(async () => {
      announceBucketWrite({ workspaceId: WORKSPACE, path: "meetings/2026-09-07-standup-a1b2c3d4.md" });
    });
    await settle();

    expect(drawn("")).toEqual(["meetings"]);
  });

  test("an ancestor nobody is holding is not fetched for nothing", async () => {
    // `refresh` on a folder no surface has asked for is a request whose answer
    // nothing draws. The parent is the exception: it is the folder that
    // certainly changed.
    const asked: string[] = [];
    actions[name("listFiles")] = async (args: never) => {
      const { path } = args as unknown as { path: string };
      asked.push(path);
      return onDisk[path] ?? listing(path, []);
    };
    unmount = mount();
    await settle();

    asked.length = 0;
    await act(async () => {
      announceBucketWrite({
        workspaceId: WORKSPACE,
        path: "1-projects/deep/nested/2026-09-07-standup-a1b2c3d4.md",
      });
    });
    await settle();

    // The root is held (the browser loads it on mount) and the parent is
    // unconditional. `1-projects` and `1-projects/deep` are neither.
    expect([...new Set(asked)].sort()).toEqual(["", "1-projects/deep/nested"]);
  });

  /**
   * SABOTAGE: drop the `write.workspaceId !== workspaceId` guard. Fails here.
   */
  test("a write to another context refreshes nothing here", async () => {
    unmount = mount();
    await settle();

    await act(async () => {
      browser.select("0-inbox/meetings");
    });
    await settle();

    /*
      One device is signed into several contexts and this hook is mounted for
      one of them. The same folder path means a different folder in a different
      bucket, so a reload here would be a request answering a question nobody
      asked — and, on a slow link, a folder redrawn from another context's
      timing.
    */
    onDisk["0-inbox/meetings"] = listing("0-inbox/meetings", ["should-not-appear.md"]);
    await act(async () => {
      announceBucketWrite({ workspaceId: OTHER_WORKSPACE, path: MEETING });
    });
    await settle();

    expect(drawn("0-inbox/meetings")).toEqual([]);
  });
});

describe("the meeting write announcing itself", () => {
  /**
   * The two ends have to meet: the console listens, and this is the one thing
   * in the product that speaks. `writeNoteThrough` is the whole of the meeting
   * write path to the bucket — `convexGateway` is handed its result — so a
   * meeting that lands without announcing is a stale folder on every client
   * that had read it.
   *
   * SABOTAGE: remove the `announceBucketWrite` call. Fails here.
   */
  test("a meeting note announces the folder it landed in", async () => {
    const heard: Array<{ workspaceId: string; path: string }> = [];
    const off = onBucketWrite((write) => heard.push({ ...write }));

    const write = writeNoteThrough({
      action: async () => ({ path: MEETING }),
    });
    await write({ workspaceId: WORKSPACE, path: MEETING, text: "# Standup" });
    off();

    expect(heard).toEqual([{ workspaceId: WORKSPACE, path: MEETING }]);
  });

  test("...at the path the bucket answered, not the one that was asked for", async () => {
    // The action returns the key that was actually written. Announcing the
    // requested path would send the console to reload a folder the note is not
    // in on the day those two stop agreeing.
    const heard: string[] = [];
    const off = onBucketWrite((write) => heard.push(write.path));

    const write = writeNoteThrough({
      action: async () => ({ path: "0-inbox/meetings/renamed-by-the-server.md" }),
    });
    await write({ workspaceId: WORKSPACE, path: MEETING, text: "# Standup" });
    off();

    expect(heard).toEqual(["0-inbox/meetings/renamed-by-the-server.md"]);
  });

  test("a write that failed announces nothing", async () => {
    /*
      An announcement of a write that then failed makes every listener reload a
      folder to learn nothing — and raises the console's "the file list did not
      reload" notice about an operation that never happened.
    */
    const heard: string[] = [];
    const off = onBucketWrite((write) => heard.push(write.path));

    const write = writeNoteThrough({
      action: async () => {
        throw new Error("the bucket said no");
      },
    });
    await expect(write({ workspaceId: WORKSPACE, path: MEETING, text: "# Standup" })).rejects.toThrow();
    off();

    expect(heard).toEqual([]);
  });
});
