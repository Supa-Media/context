import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch } from "../features/offline/epoch";
import { readIndex } from "../features/offline/mirror";
import { INCOMPLETE_WALK_MS } from "../features/offline/mirrorListing";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";
import {
  syncAll,
  type BatchRead,
  type ChangesPage,
  type ManifestEntry,
  type MirrorSyncDeps,
} from "../features/offline/mirrorSync";

/**
 * A phone's sync stays quiet when there is nothing to do. Dev2 (2026-10-16)
 * found the phone app ignoring every tap, Back included, for about a minute
 * at a time, with the download pill stuck at "2,828 / 2,831": three notes
 * that would not download left the copy incomplete, an incomplete copy was
 * walked whole on every trigger, and every walk rewrote a multi-megabyte
 * index on the JS thread. Each rule fails its test when removed:
 *
 *  - a copy missing only notes the server would not read catches up from the
 *    change log, and is walked whole again only after `INCOMPLETE_WALK_MS`;
 *  - a copy an interrupted connection left short is not held back that way;
 *  - a catch-up that brings nothing writes nothing;
 *  - a catch-up never calls an incomplete copy complete.
 */

const W = "w1";

interface Remote {
  path: string;
  text: string;
  etag: string;
}

let bucket: Remote[];
let store: MirrorStore;
let clock: number;
let calls: string[];
let changePages: ChangesPage[];
let refused: Set<string>;
let indexWrites: number;

function entryOf(note: Remote): ManifestEntry {
  return {
    path: note.path,
    etag: note.etag,
    size: note.text.length,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

function page(overrides: Partial<ChangesPage> = {}): ChangesPage {
  return {
    full: false,
    entries: [],
    folders: [],
    gone: [],
    goneFolders: [],
    since: 100,
    after: "",
    more: false,
    privacy: "nodes:e1",
    manifestUsable: true,
    ...overrides,
  };
}

function deps(overrides: Partial<MirrorSyncDeps> = {}): MirrorSyncDeps {
  const epoch = currentEpoch();
  return {
    store,
    epoch,
    mine: () => epoch === currentEpoch(),
    now: () => clock,
    needed: async () => () => new Set(),
    manifest: async (_workspaceId, cursor) => {
      calls.push("manifest");
      return {
        entries: bucket.map(entryOf),
        cursor: null,
        truncated: false,
        manifestUsable: true,
        ...(cursor === undefined ? { since: 100, privacy: "nodes:e1" } : {}),
      };
    },
    changes: async () => {
      calls.push("changes");
      const next = changePages.shift();
      if (next === undefined) throw new Error("no page scripted");
      return next;
    },
    readNotes: async (_workspaceId, paths) => {
      calls.push(`read:${paths.join(",")}`);
      return paths.map((path): BatchRead => {
        const found = bucket.find((note) => note.path === path);
        if (refused.has(path)) return { path, outcome: "error", code: "READ_FAILED", message: "no" };
        return found === undefined
          ? { path, outcome: "error", code: "FILE_NOT_FOUND", message: "not found" }
          : {
              path,
              outcome: "read",
              note: { ...entryOf(found), etag: found.etag, text: found.text, encrypted: false },
            };
      });
    },
    ...overrides,
  };
}

const target = { workspaceId: W, tier: "private" as const };

beforeEach(() => {
  const inner = memoryMirrorStore();
  indexWrites = 0;
  store = {
    ...inner,
    writeIndex: (...args) => {
      indexWrites += 1;
      return inner.writeIndex(...args);
    },
  };
  clock = 1_000;
  calls = [];
  changePages = [];
  refused = new Set();
  bucket = [
    { path: "index.md", text: "# Home\n", etag: "h1" },
    { path: "1-projects/plan.md", text: "plan v1\n", etag: "p1" },
    { path: "1-projects/huge.md", text: "huge\n", etag: "u1" },
  ];
});

describe("a copy missing notes the server would not read", () => {
  beforeEach(async () => {
    refused.add("1-projects/huge.md");
    await syncAll(deps(), [target]);
    const index = await readIndex(store, "private", W);
    expect(index?.complete).toBe(false);
    expect(index?.incomplete).toBe("read-failed");
    calls = [];
  });

  test("catches up from the change log instead of walking again", async () => {
    clock += 60_000;
    changePages = [page({ since: 110, entries: [entryOf({ ...bucket[1]!, etag: "p2" })] })];
    bucket[1] = { ...bucket[1]!, text: "plan v2\n", etag: "p2" };
    await syncAll(deps(), [target]);
    expect(calls).not.toContain("manifest");
    expect(calls).toEqual(["changes", "read:1-projects/plan.md"]);
  });

  test("is still called incomplete after a catch-up, with what is missing counted", async () => {
    clock += 60_000;
    changePages = [page({ since: 110, entries: [entryOf({ ...bucket[1]!, etag: "p2" })] })];
    bucket[1] = { ...bucket[1]!, text: "plan v2\n", etag: "p2" };
    await syncAll(deps(), [target]);
    const index = await readIndex(store, "private", W);
    expect(index?.complete).toBe(false);
    expect(index?.remaining).toBe(1);
    expect(index?.incomplete).toBe("read-failed");
  });

  test("is walked whole, and the note asked for again, once the last walk is old enough", async () => {
    clock += INCOMPLETE_WALK_MS + 1;
    await syncAll(deps(), [target]);
    expect(calls).toEqual(["manifest", "read:1-projects/huge.md"]);
  });

  test("becomes complete when the walk gets the note", async () => {
    clock += INCOMPLETE_WALK_MS + 1;
    refused.clear();
    await syncAll(deps(), [target]);
    const index = await readIndex(store, "private", W);
    expect(index?.complete).toBe(true);
  });
});

describe("a copy left at an older version of a note", () => {
  test("is not called complete by a catch-up that did not mention it", async () => {
    await syncAll(deps(), [target]);
    // A catch-up hears plan.md is at p2 and cannot read it: the device keeps p1.
    clock += 60_000;
    bucket[1] = { ...bucket[1]!, text: "plan v2\n", etag: "p2" };
    refused.add("1-projects/plan.md");
    changePages = [page({ since: 120, entries: [entryOf(bucket[1]!)] })];
    await syncAll(deps(), [target]);
    expect((await readIndex(store, "private", W))?.complete).toBe(false);
    // A catch-up about another note cannot see that plan.md is behind.
    clock += 60_000;
    bucket[0] = { ...bucket[0]!, text: "# Home 2\n", etag: "h2" };
    changePages = [page({ since: 130, entries: [entryOf(bucket[0]!)] })];
    await syncAll(deps(), [target]);
    const index = await readIndex(store, "private", W);
    expect(index?.complete).toBe(false);
    expect(index?.incomplete).toBe("read-failed");
  });
});

describe("a copy a dropped connection left short", () => {
  test("walks and resumes the downloads on the next trigger", async () => {
    let fail = true;
    const flaky = deps({
      readNotes: async (workspaceId, paths) => {
        if (fail) throw new Error("timed out");
        return deps().readNotes(workspaceId, paths);
      },
    });
    await syncAll(flaky, [target]);
    expect((await readIndex(store, "private", W))?.incomplete).toBe("interrupted");
    fail = false;
    calls = [];
    clock += 60_000;
    await syncAll(flaky, [target]);
    expect(calls[0]).toBe("manifest");
    expect((await readIndex(store, "private", W))?.complete).toBe(true);
  });
});

describe("a catch-up that brings nothing", () => {
  test("writes nothing to the device", async () => {
    await syncAll(deps(), [target]);
    expect((await readIndex(store, "private", W))?.complete).toBe(true);
    indexWrites = 0;
    calls = [];
    clock += 60_000;
    changePages = [page()];
    const checked: string[] = [];
    await syncAll(deps({ onChecked: (workspaceId) => checked.push(workspaceId) }), [target]);
    expect(calls).toEqual(["changes"]);
    expect(indexWrites).toBe(0);
    // Still said to be current as of now.
    expect(checked).toEqual([W]);
  });

  test("still writes when only the cursor moved", async () => {
    await syncAll(deps(), [target]);
    indexWrites = 0;
    clock += 60_000;
    changePages = [page({ since: 120 })];
    await syncAll(deps(), [target]);
    expect(indexWrites).toBeGreaterThan(0);
    expect((await readIndex(store, "private", W))?.changes?.since).toBe(120);
  });
});
