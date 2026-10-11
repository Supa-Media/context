import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch } from "../features/offline/epoch";
import { mirroredNote, readIndex } from "../features/offline/mirror";
import { FULL_WALK_MS } from "../features/offline/mirrorListing";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";
import {
  syncContext,
  type BatchRead,
  type ChangesPage,
  type ManifestEntry,
  type MirrorSyncDeps,
} from "../features/offline/mirrorSync";

/**
 * An app's copy catches up from the tree table's change log instead of
 * walking the whole tree, while its last whole walk is fresh. Each rule here
 * fails its test when removed (sabotage-checked while writing):
 *
 *  - a walk's first page records where a catch-up starts, and a truncated
 *    walk records nothing;
 *  - a catch-up applies changed notes and drops gone ones, and never prunes
 *    what it did not hear about;
 *  - the server saying `full`, a privacy change, a stale walk or a failed
 *    page each fall back to a walk or change nothing.
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
let changePages: ChangesPage[] | Error;

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
    since: 200,
    after: "",
    more: false,
    privacy: "e1",
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
        ...(cursor === undefined ? { since: 100, privacy: "e1" } : {}),
      };
    },
    changes: async (_workspaceId, cursor) => {
      calls.push(`changes:${cursor.since}:${cursor.after}:${cursor.privacy}`);
      if (changePages instanceof Error) throw changePages;
      const next = changePages.shift();
      if (next === undefined) throw new Error("no page scripted");
      return next;
    },
    readNotes: async (_workspaceId, paths) => {
      calls.push(`read:${paths.join(",")}`);
      return paths.map((path): BatchRead => {
        const found = bucket.find((note) => note.path === path);
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
  store = memoryMirrorStore();
  clock = 1_000;
  calls = [];
  changePages = [];
  bucket = [
    { path: "index.md", text: "# Home\n", etag: "h1" },
    { path: "1-projects/plan.md", text: "plan v1\n", etag: "p1" },
    { path: "1-projects/old.md", text: "old\n", etag: "o1" },
  ];
});

describe("a walk records where a catch-up starts", () => {
  test("from the walk's first page", async () => {
    await syncContext(deps(), target);
    const index = await readIndex(store, "private", W);
    expect(index?.changes).toEqual({ since: 100, after: "", privacy: "e1", walkedAt: 1_000 });
  });

  test("not from a truncated walk", async () => {
    await syncContext(
      deps({
        manifest: async () => ({
          entries: bucket.map(entryOf),
          cursor: null,
          truncated: true,
          manifestUsable: true,
          since: 100,
          privacy: "e1",
        }),
      }),
      target,
    );
    expect((await readIndex(store, "private", W))?.changes).toBeUndefined();
  });
});

describe("a catch-up", () => {
  test("applies what changed and drops what went, without walking", async () => {
    await syncContext(deps(), target);
    calls = [];
    clock = 2_000;
    bucket[1] = { path: "1-projects/plan.md", text: "plan v2\n", etag: "p2" };
    bucket = bucket.filter((note) => note.path !== "1-projects/old.md");
    changePages = [page({ entries: [entryOf(bucket[1]!)], gone: ["1-projects/old.md"], since: 300, after: "x" })];
    const run = await syncContext(deps(), target);
    expect(run?.complete).toBe(true);
    expect(calls).toEqual(["changes:100::e1", "read:1-projects/plan.md"]);
    expect((await mirroredNote(store, "private", W, "1-projects/plan.md"))?.value.text).toBe("plan v2\n");
    expect(await mirroredNote(store, "private", W, "1-projects/old.md")).toBeNull();
    // Unmentioned notes stay: a catch-up is not the whole list.
    expect((await mirroredNote(store, "private", W, "index.md"))?.value.text).toBe("# Home\n");
    const index = await readIndex(store, "private", W);
    expect(index?.changes).toEqual({ since: 300, after: "x", privacy: "e1", walkedAt: 1_000 });
    expect(index?.listedComplete).toBe(true);
  });

  test("follows pages until the log says it is done", async () => {
    await syncContext(deps(), target);
    calls = [];
    changePages = [page({ more: true, since: 150, after: "a" }), page({ since: 160, after: "b" })];
    await syncContext(deps(), target);
    expect(calls.filter((call) => call.startsWith("changes"))).toEqual(["changes:100::e1", "changes:150:a:e1"]);
    expect((await readIndex(store, "private", W))?.changes?.since).toBe(160);
  });

  test("walks when the server says the log cannot answer", async () => {
    await syncContext(deps(), target);
    calls = [];
    changePages = [page({ full: true })];
    await syncContext(deps(), target);
    expect(calls).toContain("manifest");
  });

  test("walks when privacy.md changed", async () => {
    await syncContext(deps(), target);
    calls = [];
    changePages = [page({ privacy: null })];
    await syncContext(deps(), target);
    expect(calls).toContain("manifest");
  });

  test("walks once the last whole walk is an hour old", async () => {
    await syncContext(deps(), target);
    calls = [];
    clock = 1_000 + FULL_WALK_MS;
    await syncContext(deps(), target);
    expect(calls[0]).toBe("manifest");
    expect((await readIndex(store, "private", W))?.changes?.walkedAt).toBe(clock);
  });

  test("a log that cannot be reached changes nothing", async () => {
    await syncContext(deps(), target);
    calls = [];
    changePages = new Error("offline");
    const run = await syncContext(deps(), target);
    expect(run?.complete).toBe(false);
    expect((await mirroredNote(store, "private", W, "1-projects/old.md"))?.value.text).toBe("old\n");
    expect((await readIndex(store, "private", W))?.changes?.since).toBe(100);
  });
});
