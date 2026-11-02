import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch } from "../features/offline/epoch";
import { readIndex } from "../features/offline/mirror";
import { readForMirror } from "../features/offline/mirrorReads";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";
import { syncAll, type BatchRead, type ManifestEntry, type MirrorSyncDeps } from "../features/offline/mirrorSync";

/**
 * A note whose collaboration document will not open still downloads, as the
 * Markdown the bucket holds (Dev2, 2026-10-16: the pill stuck at
 * "2,828 / 2,831"). Sabotage: `readForMirror` returning the first answer
 * unchanged fails "the copy settles" and "one plain read".
 */

const W = "w1";
const notes = [
  { path: "a.md", text: "a\n", etag: "ea" },
  { path: "broken.md", text: "broken\n", etag: "eb" },
];
let store: MirrorStore;
let asked: { paths: string[]; plain: boolean }[];

function entryOf(note: (typeof notes)[number]): ManifestEntry {
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

/** The server: `broken.md`'s document will not open, its Markdown reads fine. */
async function server(paths: string[], plain: boolean): Promise<BatchRead[]> {
  asked.push({ paths, plain });
  return paths.map((path): BatchRead => {
    const note = notes.find((n) => n.path === path)!;
    if (path === "broken.md" && !plain) {
      return { path, outcome: "error", code: "STORAGE_UNSAFE", message: "cannot be opened safely" };
    }
    return { path, outcome: "read", note: { ...entryOf(note), etag: note.etag, text: note.text, encrypted: false } };
  });
}

function deps(): MirrorSyncDeps {
  const epoch = currentEpoch();
  return {
    store,
    epoch,
    mine: () => epoch === currentEpoch(),
    now: () => 1_000,
    needed: async () => () => new Set(),
    manifest: async () => ({ entries: notes.map(entryOf), cursor: null, truncated: false, manifestUsable: true }),
    readNotes: (_workspaceId, paths) => readForMirror(server, paths),
  };
}

beforeEach(() => {
  store = memoryMirrorStore();
  asked = [];
});

describe("a note whose collaboration document will not open", () => {
  test("is asked for once more as plain Markdown, and only it", async () => {
    const results = await readForMirror(server, ["a.md", "broken.md"]);
    expect(asked).toEqual([
      { paths: ["a.md", "broken.md"], plain: false },
      { paths: ["broken.md"], plain: true },
    ]);
    expect(results.map((r) => [r.path, r.outcome])).toEqual([
      ["a.md", "read"],
      ["broken.md", "read"],
    ]);
  });

  test("the copy settles: complete, nothing remaining, nothing asked again", async () => {
    await syncAll(deps(), [{ workspaceId: W, tier: "private" }]);
    const index = await readIndex(store, "private", W);
    expect(index?.complete).toBe(true);
    expect(index?.remaining ?? 0).toBe(0);
    asked = [];
    await syncAll(deps(), [{ workspaceId: W, tier: "private" }]);
    expect(asked).toEqual([]);
  });

  test("a plain read that fails leaves the first answer", async () => {
    let calls = 0;
    const results = await readForMirror(async (paths, plain) => {
      calls += 1;
      if (plain) throw new Error("timed out");
      return server(paths, plain);
    }, ["broken.md"]);
    expect(calls).toBe(2);
    expect(results[0]).toMatchObject({ outcome: "error", code: "STORAGE_UNSAFE" });
  });

  test("no unsafe answer, no second call", async () => {
    await readForMirror(server, ["a.md"]);
    expect(asked).toHaveLength(1);
  });
});
