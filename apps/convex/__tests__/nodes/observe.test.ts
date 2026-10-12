/**
 * The tree's rules, over the in-memory table. These are the same functions the
 * Convex mutations run (`functions/nodes.ts`), so each case is a claim about
 * production, checked without a deployment.
 *
 * Last observation wins: an older look never overwrites a newer one, a
 * tombstone blocks an older upsert and yields to a newer one, and a sweep
 * removes only what nothing observed since it began.
 */

import { describe, expect, test } from "vitest";
import {
  NodeTreeUnsupportedError,
  applyObservation,
  beginState,
  finishState,
  pruneUnobserved,
} from "../../functions/lib/nodes/observe";
import { PRUNE_BATCH, VANISH_SCAN, type NodeTable, type StoredNode } from "../../functions/lib/nodes/table";
import { applyAll, memoryNodeSink, memoryNodeTable } from "../nodeTable.helpers";

const obs = (at: number, rows: { path: string; etag?: string; size?: number; uploaded?: number }[] = [], gone: string[] = [], vanishedUnder: string[] = []) => ({
  at,
  rows,
  gone,
  vanishedUnder,
});

function find(table: { rows(): StoredNode[] }, path: string): StoredNode | undefined {
  return table.rows().find((node) => node.path === path);
}

describe("applyObservation: the folder chain", () => {
  test("creates each folder of a key and links parents, root first", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "1-projects/a/b.md", etag: "e1", size: 4, uploaded: 99 }]));

    const top = find(table, "1-projects");
    const mid = find(table, "1-projects/a");
    const file = find(table, "1-projects/a/b.md");
    expect(top).toMatchObject({ kind: "folder", name: "1-projects", observedAt: 10 });
    expect(top?.parentId).toBeUndefined();
    expect(mid).toMatchObject({ kind: "folder", name: "a", observedAt: 10 });
    expect(mid?.parentId).toBe(top?.id);
    expect(file).toMatchObject({ kind: "file", name: "b.md", etag: "e1", size: 4, uploaded: 99, observedAt: 10 });
    expect(file?.parentId).toBe(mid?.id);
  });

  test("a file at the root has no parent and no folder is made", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "todo.md", etag: "t" }]));
    expect(table.rows()).toHaveLength(1);
    expect(find(table, "todo.md")).toMatchObject({ kind: "file", name: "todo.md", parentId: undefined });
  });

  test("a folder is inserted once however many files sit in it", async () => {
    const inner = memoryNodeTable();
    let folderInserts = 0;
    const counting: NodeTable = {
      ...inner,
      insert: async (node) => {
        if (node.kind === "folder") folderInserts += 1;
        return inner.insert(node);
      },
      byPath: (path) => inner.byPath(path),
      patch: (id, fields) => inner.patch(id, fields),
      remove: (id) => inner.remove(id),
      underPrefix: (prefix, options) => inner.underPrefix(prefix, options),
      observedBefore: (before, limit) => inner.observedBefore(before, limit),
    };
    const rows = Array.from({ length: 30 }, (_, index) => ({ path: `big/deep/f${index}.md`, etag: `e${index}` }));
    await applyObservation(counting, obs(10, rows));

    expect(folderInserts).toBe(2);
    expect(inner.rows().filter((node) => node.kind === "file")).toHaveLength(30);
  });

  test("a folder seen again keeps its id and takes the newer observation time", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "f/a.md" }]));
    const folder = find(table, "f")?.id;
    await applyAll(table, obs(20, [{ path: "f/b.md" }]));
    expect(find(table, "f")).toMatchObject({ id: folder, observedAt: 20 });
    await applyAll(table, obs(5, [{ path: "f/c.md" }]));
    expect(find(table, "f")?.observedAt).toBe(20);
  });
});

describe("applyObservation: last observation wins", () => {
  test("an older observation never overwrites a newer row", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(20, [{ path: "a.md", etag: "new", size: 2 }]));
    await applyAll(table, obs(10, [{ path: "a.md", etag: "old", size: 1 }]));
    expect(find(table, "a.md")).toMatchObject({ etag: "new", size: 2, observedAt: 20 });
  });

  test("a newer observation replaces the version and clears fields the row no longer has", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "a.md", etag: "one", size: 1, uploaded: 5 }]));
    await applyAll(table, obs(20, [{ path: "a.md", etag: "two" }]));
    expect(find(table, "a.md")).toMatchObject({ etag: "two", observedAt: 20 });
    expect(find(table, "a.md")?.size).toBeUndefined();
    expect(find(table, "a.md")?.uploaded).toBeUndefined();
  });

  test("a row whose path is not a key the tree keeps is skipped", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: ".context/reads/x.json" }, { path: "" }, { path: "ok.md" }]));
    expect(table.rows().map((node) => node.path)).toEqual(["ok.md"]);
  });
});

describe("applyObservation: tombstones", () => {
  test("a tombstone blocks an older upsert, and a newer upsert revives the file", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "a.md", etag: "v1" }]));
    await applyAll(table, obs(20, [], ["a.md"]));
    expect(find(table, "a.md")?.goneAt).toBe(20);

    await applyAll(table, obs(15, [{ path: "a.md", etag: "stale" }]));
    expect(find(table, "a.md")).toMatchObject({ etag: "v1", goneAt: 20, observedAt: 10 });

    await applyAll(table, obs(25, [{ path: "a.md", etag: "v2" }]));
    expect(find(table, "a.md")).toMatchObject({ etag: "v2", observedAt: 25, goneAt: undefined });
  });

  test("gone ignores folders, keys observed later, and keys it never saw", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "f/a.md" }, { path: "late.md" }]));
    await applyAll(table, obs(5, [], ["f", "f/a.md"]));
    expect(find(table, "f")?.goneAt).toBeUndefined();
    // Seen at 10, reported gone at 5: the newer row stands.
    expect(find(table, "f/a.md")?.goneAt).toBeUndefined();

    await applyAll(table, obs(7, [], ["late.md", "never-seen.md"]));
    expect(find(table, "late.md")?.goneAt).toBeUndefined();
    expect(find(table, "never-seen.md")).toBeUndefined();
  });

  test("gone of a live file older than the observation tombstones it", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "f/a.md" }]));
    await applyAll(table, obs(30, [], ["f/a.md"]));
    expect(find(table, "f/a.md")).toMatchObject({ goneAt: 30, observedAt: 10 });
    expect(find(table, "f")?.goneAt).toBeUndefined();
  });
});

describe("applyObservation: vanishedUnder", () => {
  test("marks only live files under the prefix that are not listed and were seen earlier", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "1-projects/a.md" }, { path: "1-projects/b.md" }, { path: "1-projectsX/z.md" }]));
    await applyAll(table, obs(20, [{ path: "1-projects/b.md" }], [], ["1-projects/"]));

    expect(find(table, "1-projects/a.md")).toMatchObject({ goneAt: 20 });
    expect(find(table, "1-projects/b.md")?.goneAt).toBeUndefined();
    expect(find(table, "1-projectsX/z.md")?.goneAt).toBeUndefined();
  });

  test("does not mark a file observed at or after the observation", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(30, [{ path: "p/n.md" }]));
    await applyAll(table, obs(20, [], [], ["p/"]));
    expect(find(table, "p/n.md")?.goneAt).toBeUndefined();
  });

  test("folders under the prefix are never tombstoned", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "p/q/a.md" }]));
    await applyAll(table, obs(20, [], [], ["p/"]));
    expect(find(table, "p/q")?.goneAt).toBeUndefined();
    expect(find(table, "p/q/a.md")?.goneAt).toBe(20);
  });

  test("a scan over more than VANISH_SCAN files answers more, and re-applying completes it", async () => {
    const table = memoryNodeTable();
    const total = VANISH_SCAN + 50;
    const rows = Array.from({ length: total }, (_, index) => ({ path: `big/f${String(index).padStart(5, "0")}.md` }));
    await applyAll(table, obs(10, rows));

    const first = await applyObservation(table, obs(20, [], [], ["big/"]));
    expect(first.more).toBe(true);
    expect(first.next).toBeDefined();

    const calls = await applyAll(table, obs(20, [], [], ["big/"]));
    expect(calls).toBeGreaterThanOrEqual(1);
    const live = table.rows().filter((node) => node.kind === "file" && node.goneAt === undefined);
    expect(live).toHaveLength(0);
    expect(table.rows().filter((node) => node.goneAt === 20)).toHaveLength(total);
  });
});

describe("pruneUnobserved", () => {
  test("removes what nobody observed since the sweep began, and keeps what was observed", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "gone/b.md" }, { path: "t.md" }, { path: "keep/a.md" }]));
    await applyAll(table, obs(15, [], ["t.md"]));
    await applyAll(table, obs(50, [{ path: "keep/a.md" }]));

    const result = await pruneUnobserved(table, 40);
    expect(result).toEqual({ more: false, removedFiles: 2 });
    expect(table.rows().map((node) => node.path).sort()).toEqual(["keep", "keep/a.md"]);
  });

  test("answers more when a batch is full, and a second call finishes", async () => {
    const table = memoryNodeTable();
    const rows = Array.from({ length: PRUNE_BATCH + 1 }, (_, index) => ({ path: `old/f${index}.md` }));
    await applyAll(table, obs(10, rows));

    // The batch is full of nodes, and the one folder (`old`) is among them, so
    // the first call removes PRUNE_BATCH - 1 files.
    const first = await pruneUnobserved(table, 40);
    expect(first.more).toBe(true);
    expect(first.removedFiles).toBe(PRUNE_BATCH - 1);
    const second = await pruneUnobserved(table, 40);
    expect(second).toEqual({ more: false, removedFiles: 2 });
    expect(table.rows()).toHaveLength(0);
  });
});

describe("beginState / finishState", () => {
  test("a fresh sweep lists from the start, takes the lease, and is filling", () => {
    const { state, cursor, startedAt } = beginState(null, 5);
    expect(cursor).toBe("");
    expect(startedAt).toBe(5);
    expect(state).toMatchObject({ status: "filling", cursor: "", startedAt: 5, leaseAt: 5, dirty: false, files: 0 });
  });

  test("a ready tree stays ready while a re-sweep runs", () => {
    const ready = { status: "ready" as const, sweptAt: 3, dirty: false, files: 4 };
    const { state } = beginState(ready, 9);
    expect(state.status).toBe("ready");
    expect(state.startedAt).toBe(9);
    expect(state.files).toBe(4);
  });

  test("joining a running sweep keeps its cursor and the earlier start, and clears dirty", () => {
    const running = { status: "filling" as const, cursor: "a/b", startedAt: 4, leaseAt: 6, dirty: true, files: 0 };
    const { state, cursor, startedAt } = beginState(running, 9);
    expect(cursor).toBe("a/b");
    expect(startedAt).toBe(4);
    expect(state).toMatchObject({ cursor: "a/b", startedAt: 4, leaseAt: 9, dirty: false });
  });

  test("an unsupported store refuses to begin", () => {
    expect(() => beginState({ status: "unsupported", dirty: false, files: 0 }, 1)).toThrow(NodeTreeUnsupportedError);
  });

  test("finishing makes the tree ready and clears the sweep's bookkeeping, but keeps a dirty request", () => {
    const running = {
      status: "filling" as const,
      cursor: "z",
      startedAt: 4,
      leaseAt: 6,
      dirty: true,
      files: 0,
      error: "boom",
    };
    const done = finishState(running, 30, 7);
    expect(done).toEqual({ status: "ready", sweptAt: 30, dirty: true, files: 7 });
    expect("cursor" in done).toBe(false);
    expect("error" in done).toBe(false);
  });

  test("an unsupported store refuses to finish", () => {
    expect(() => finishState({ status: "unsupported", dirty: false, files: 0 }, 30, 0)).toThrow(NodeTreeUnsupportedError);
  });
});

describe("memoryNodeSink: a sweep end to end", () => {
  test("begin, observe, prune and finish leave a ready tree that holds what was listed", async () => {
    const sink = memoryNodeSink();
    const { startedAt } = await sink.begin(10);
    await sink.observe({ at: 11, rows: [{ path: "a/x.md" }, { path: "y.md" }], gone: [], vanishedUnder: [] });
    await sink.prune(startedAt);
    await sink.finish(20);

    expect(await sink.state()).toMatchObject({ status: "ready", sweptAt: 20, files: 2, dirty: false });
    expect(sink.table.rows().map((node) => node.path).sort()).toEqual(["a", "a/x.md", "y.md"]);
  });

  test("a sweep prunes what the previous state held and nothing listed again", async () => {
    const sink = memoryNodeSink();
    await sink.begin(10);
    await sink.observe({ at: 11, rows: [{ path: "old.md" }, { path: "kept.md" }], gone: [], vanishedUnder: [] });
    await sink.finish(12);

    const { startedAt } = await sink.begin(30);
    await sink.observe({ at: 31, rows: [{ path: "kept.md" }], gone: [], vanishedUnder: [] });
    await sink.prune(startedAt);
    await sink.finish(40);

    expect(sink.table.rows().map((node) => node.path)).toEqual(["kept.md"]);
    expect(await sink.state()).toMatchObject({ status: "ready", files: 1 });
  });

  test("a dirty request survives the sweep that was running when it arrived", async () => {
    const sink = memoryNodeSink();
    await sink.begin(10);
    await sink.dirty();
    await sink.finish(20);
    expect(await sink.state()).toMatchObject({ status: "ready", dirty: true });
  });

  test("a failure label is kept until the next finish", async () => {
    const sink = memoryNodeSink();
    await sink.begin(10);
    await sink.fail("the storage listing failed");
    expect(await sink.state()).toMatchObject({ error: "the storage listing failed" });
    await sink.finish(20);
    expect(await sink.state()).not.toHaveProperty("error");
  });

  test("privacy is kept only while no newer read has been saved", async () => {
    const sink = memoryNodeSink();
    await sink.savePrivacy({ invalid: false, folders: [], notes: [{ path: "a.md", visibility: "private" }] }, 20);
    await sink.savePrivacy({ invalid: true, folders: [], notes: [] }, 10);
    expect(await sink.privacy()).toEqual({ invalid: false, folders: [], notes: [{ path: "a.md", visibility: "private" }] });
  });
});
