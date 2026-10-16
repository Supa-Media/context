import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch } from "../features/offline/epoch";
import { readIndex, type Needed } from "../features/offline/mirror";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";
import { syncContext, type BatchRead, type ManifestEntry, type MirrorSyncDeps } from "../features/offline/mirrorSync";
import { memoryStore } from "../features/offline/memory";
import { sweep } from "../features/offline/cache";
import { keyFor } from "../features/offline/keys";
import {
  downloadsPath,
  forgetDownloadChoices,
  isOnlineOnly,
  keepsBody,
  loadDownloadChoices,
  setOnlineOnly,
} from "../features/offline/downloadChoice";
import { downloadPill, downloadRows, rowStatus } from "../features/offline/downloadSummary";

/**
 * What the phone downloads (owner, 2026-10-16): everything but Archive, and
 * nothing for a workspace kept online only. Sabotage-checked while writing:
 * fetching every `.md` again fails "Archive is listed, never downloaded";
 * dropping the reconcile's body sweep fails "a body an older build downloaded
 * goes"; ignoring `needed` there fails "unsent work keeps its body".
 */

const W = "w1";

interface Remote {
  path: string;
  text: string;
  etag: string;
  updatedAt?: number;
}

let bucket: Remote[];
let reads: string[][];
let store: MirrorStore;
let needed: Needed;
let keeps: (workspaceId: string, path: string) => boolean;

function entryOf(note: Remote): ManifestEntry {
  return {
    path: note.path,
    etag: note.etag,
    size: note.text.length,
    ...(note.updatedAt === undefined ? {} : { updatedAt: note.updatedAt }),
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
    needed: async () => needed,
    keepsBody: (workspaceId, path) => keeps(workspaceId, path),
    manifest: async () => ({ entries: bucket.map(entryOf), cursor: null, truncated: false, manifestUsable: true }),
    readNotes: async (_workspaceId, paths) => {
      reads.push(paths);
      return paths.map((path): BatchRead => {
        const found = bucket.find((note) => note.path === path)!;
        return {
          path,
          outcome: "read",
          note: {
            path,
            text: found.text,
            etag: found.etag,
            visibility: "private",
            inherited: "private",
            exception: false,
            readOnly: false,
          },
        };
      });
    },
  };
}

const target = { workspaceId: W, tier: "private" as const };

async function bodies(): Promise<string[]> {
  const index = await readIndex(store, "private", W);
  return [...(index?.entries.values() ?? [])].filter((entry) => entry.body).map((entry) => entry.path).sort();
}

async function listedPaths(): Promise<string[]> {
  const index = await readIndex(store, "private", W);
  return [...(index?.entries.keys() ?? [])].sort();
}

beforeEach(() => {
  store = memoryMirrorStore();
  reads = [];
  needed = () => new Set();
  keeps = (_workspaceId, path) => downloadsPath(path);
  bucket = [
    { path: "todo.md", text: "todo\n", etag: "t1", updatedAt: 10 },
    { path: "1-projects/pilot.md", text: "pilot\n", etag: "p1", updatedAt: 30 },
    { path: "4-archive/2026-09-01T00-00-00-000Z/old.md", text: "old\n", etag: "o1", updatedAt: 50 },
    { path: "9-archive/gone.md", text: "gone\n", etag: "g1", updatedAt: 40 },
  ];
});

describe("which notes the phone downloads", () => {
  test("only the archive role stays online", () => {
    expect(downloadsPath("todo.md")).toBe(true);
    expect(downloadsPath("1-projects/pilot.md")).toBe(true);
    expect(downloadsPath("1-projects/archive/x.md")).toBe(true);
    expect(downloadsPath("4-archive/x.md")).toBe(false);
    expect(downloadsPath("9-archive/a/b.md")).toBe(false);
    expect(downloadsPath("Archive/x.md")).toBe(false);
  });

  test("Archive is listed, never downloaded, and not counted", async () => {
    const run = await syncContext(deps(), target);
    expect(reads.flat().sort()).toEqual(["1-projects/pilot.md", "todo.md"]);
    expect(await bodies()).toEqual(["1-projects/pilot.md", "todo.md"]);
    // The names are still on the device, so the tree is whole offline.
    expect(await listedPaths()).toContain("9-archive/gone.md");
    expect(run?.complete).toBe(true);
    expect(run?.remaining).toBe(0);
  });

  test("the most recently edited notes come down first", async () => {
    await syncContext(deps(), target);
    expect(reads.flat()).toEqual(["1-projects/pilot.md", "todo.md"]);
  });

  test("a body an older build downloaded goes, its name stays", async () => {
    keeps = () => true;
    await syncContext(deps(), target);
    expect(await bodies()).toContain("9-archive/gone.md");

    keeps = (_workspaceId, path) => downloadsPath(path);
    await syncContext(deps(), target);
    expect(await bodies()).toEqual(["1-projects/pilot.md", "todo.md"]);
    expect(await listedPaths()).toContain("9-archive/gone.md");
  });

  test("unsent work keeps its body", async () => {
    keeps = () => true;
    await syncContext(deps(), target);
    needed = (path) => (path === "9-archive/gone.md" ? new Set(["g1"]) : new Set());
    keeps = (_workspaceId, path) => downloadsPath(path);
    await syncContext(deps(), target);
    expect(await bodies()).toContain("9-archive/gone.md");
  });

  test("an online-only workspace keeps no bodies, and drops the ones it had", async () => {
    keeps = () => true;
    await syncContext(deps(), target);
    expect((await bodies()).length).toBe(4);

    reads = [];
    keeps = () => false;
    const run = await syncContext(deps(), target);
    expect(reads).toEqual([]);
    expect(await bodies()).toEqual([]);
    expect((await listedPaths()).length).toBe(4);
    expect(run?.complete).toBe(true);
  });
});

describe("the per-workspace choice", () => {
  beforeEach(() => forgetDownloadChoices());

  test("is kept on the device and read back next session", async () => {
    const kv = memoryStore();
    await loadDownloadChoices(kv);
    await setOnlineOnly(kv, W, true);
    expect(isOnlineOnly(W)).toBe(true);
    expect(keepsBody(W, "todo.md")).toBe(false);
    expect(keepsBody("w2", "todo.md")).toBe(true);

    forgetDownloadChoices();
    expect(isOnlineOnly(W)).toBe(false);
    await loadDownloadChoices(kv);
    expect(isOnlineOnly(W)).toBe(true);

    await setOnlineOnly(kv, W, false);
    expect(await kv.get(keyFor("download", W))).toBeNull();
  });

  test("is never aged out by the cache sweep", async () => {
    const kv = memoryStore();
    await setOnlineOnly(kv, W, true);
    await sweep(kv, { now: Date.now() + 365 * 24 * 60 * 60 * 1000 });
    expect(await kv.get(keyFor("download", W))).toBe("online-only");
  });

  test("a failed write puts the switch back", async () => {
    const kv = { ...memoryStore(), set: async () => { throw new Error("full"); } };
    await expect(setOnlineOnly(kv, W, true)).rejects.toThrow("full");
    expect(isOnlineOnly(W)).toBe(false);
  });
});

describe("what the pill and the sheet say", () => {
  const contexts = [
    { id: "a", slug: "supa" },
    { id: "b", slug: "seyi" },
    { id: "c", slug: "public-worship" },
  ];
  const syncing = (notes: number, total: number) =>
    ({ state: "syncing", notes, bytes: 0, lastSyncedAt: null, total, remaining: total - notes }) as const;

  test("one pill across every workspace while anything downloads", () => {
    const rows = downloadRows(
      contexts,
      new Map([
        ["a", syncing(340, 1204)],
        ["b", { state: "synced", notes: 50, bytes: 0, lastSyncedAt: 1, total: 50 }],
      ]),
      new Set(["c"]),
    );
    expect(rows.map((row) => [row.label, row.state, rowStatus(row)])).toEqual([
      ["@supa", "downloading", "340 of 1,204"],
      ["@seyi", "done", "All 50"],
      ["@public-worship", "online-only", "Online only"],
    ]);
    expect(downloadPill(rows)?.text).toBe("340 / 1,204");
  });

  test("no pill when nothing is coming down", () => {
    const rows = downloadRows(contexts, new Map([["a", { state: "synced", notes: 3, bytes: 0, lastSyncedAt: 1, total: 3 }]]), new Set());
    expect(downloadPill(rows)).toBeNull();
  });

  test("a percentage once the numbers get long", () => {
    const rows = downloadRows([{ id: "a", slug: "big" }], new Map([["a", syncing(2_500, 10_000)]]), new Set());
    expect(downloadPill(rows)?.text).toBe("25%");
  });
});
