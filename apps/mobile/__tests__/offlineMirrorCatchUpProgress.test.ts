import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch } from "../features/offline/epoch";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";
import {
  syncAll,
  type BatchRead,
  type ChangesPage,
  type ManifestEntry,
  type MirrorProgress,
  type MirrorSyncDeps,
} from "../features/offline/mirrorSync";

/**
 * A catch-up's progress is the workspace's, not the catch-up's (Dev2,
 * 2026-10-16: "the download counter still randomly disappears"). A catch-up
 * that downloaded one changed note said "0 of 1" then "1 of 1", which the
 * pill reads as done, so it vanished until the run ended. Sabotage: dropping
 * the index count in `fetchContext` fails both tests.
 */

const W = "w1";
interface Remote {
  path: string;
  text: string;
  etag: string;
}
let bucket: Remote[];
let store: MirrorStore;
let refused: Set<string>;
let progress: MirrorProgress[];
let changePages: ChangesPage[];

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

function deps(): MirrorSyncDeps {
  const epoch = currentEpoch();
  return {
    store,
    epoch,
    mine: () => epoch === currentEpoch(),
    now: () => 1_000,
    needed: async () => () => new Set(),
    manifest: async (_workspaceId, cursor) => ({
      entries: bucket.map(entryOf),
      cursor: null,
      truncated: false,
      manifestUsable: true,
      ...(cursor === undefined ? { since: 100, privacy: "nodes:e1" } : {}),
    }),
    changes: async () => changePages.shift()!,
    readNotes: async (_workspaceId, paths) =>
      paths.map((path): BatchRead => {
        const note = bucket.find((n) => n.path === path)!;
        if (refused.has(path)) return { path, outcome: "error", code: "READ_FAILED", message: "no" };
        return { path, outcome: "read", note: { ...entryOf(note), text: note.text, encrypted: false } };
      }),
    onProgress: (_workspaceId, p) => progress.push(p),
  };
}

function page(entries: ManifestEntry[]): ChangesPage {
  return {
    full: false,
    entries,
    folders: [],
    gone: [],
    goneFolders: [],
    since: 110,
    after: "",
    more: false,
    privacy: "nodes:e1",
    manifestUsable: true,
  };
}

beforeEach(() => {
  store = memoryMirrorStore();
  refused = new Set();
  progress = [];
  changePages = [];
  bucket = Array.from({ length: 5 }, (_, n) => ({ path: `n${n}.md`, text: `${n}\n`, etag: `e${n}` }));
});

const target = { workspaceId: W, tier: "private" as const };

describe("a catch-up's progress", () => {
  test("counts the whole workspace, so a copy still short stays short", async () => {
    refused.add("n4.md");
    await syncAll(deps(), [target]); // 4 of 5, n4 refused
    progress = [];
    bucket[0] = { ...bucket[0]!, text: "0 v2\n", etag: "e0b" };
    changePages = [page([entryOf(bucket[0]!)])];
    await syncAll(deps(), [target]);
    expect(changePages).toHaveLength(0); // it caught up rather than walked
    expect(progress.length).toBeGreaterThan(0);
    for (const p of progress) expect(p.total).toBe(5);
    expect(progress.at(-1)).toEqual({ total: 5, done: 4 });
  });

  test("a new note joins the count", async () => {
    await syncAll(deps(), [target]);
    progress = [];
    bucket.push({ path: "new.md", text: "new\n", etag: "en" });
    changePages = [page([entryOf(bucket[5]!)])];
    await syncAll(deps(), [target]);
    expect(changePages).toHaveLength(0);
    expect(progress[0]).toEqual({ total: 6, done: 5 });
    expect(progress.at(-1)).toEqual({ total: 6, done: 6 });
  });
});
