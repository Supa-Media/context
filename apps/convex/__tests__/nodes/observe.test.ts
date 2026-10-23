/**
 * The tree's rules, over the in-memory table. These are the same functions the
 * Convex mutations run (`functions/nodes.ts`), so each case is a claim about
 * production, checked without a deployment.
 *
 * Last observation wins: an older look never overwrites a newer one, a
 * tombstone blocks an older upsert and yields to a newer one.
 */

import { describe, expect, test } from "vitest";
import { applyObservation } from "../../functions/lib/nodes/observe";
import { type NodeTable, type StoredNode } from "../../functions/lib/nodes/table";
import { applyAll, memoryNodeTable, seamRows } from "../nodeTable.helpers";

const obs = (at: number, rows: { path: string; etag?: string; size?: number; uploaded?: number }[] = [], gone: string[] = []) => ({
  at,
  rows,
  gone,
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
    };
    const rows = Array.from({ length: 30 }, (_, index) => ({ path: `big/deep/f${index}.md`, etag: `e${index}` }));
    await applyObservation(counting, obs(10, seamRows(rows)));

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
    // A seam write names no upload time, so the write is it (`observeRows.ts`).
    expect(find(table, "a.md")?.uploaded).toBe(20);
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
    // Its folder now holds nothing, and a listing must not draw it (phase 2).
    expect(find(table, "f")?.goneAt).toBe(30);
  });
});

describe("applyObservation: emptied folders", () => {
  test("a folder that still holds something stays, and so do its parents", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "p/q/a.md" }, { path: "p/b.md" }]));
    await applyAll(table, obs(20, [], ["p/q/a.md"]));
    expect(find(table, "p/q")?.goneAt).toBe(20);
    expect(find(table, "p")?.goneAt).toBeUndefined();
  });

  test("a file observed in a gone folder brings the whole chain back", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "p/q/a.md" }]));
    await applyAll(table, obs(20, [], ["p/q/a.md"]));
    expect(find(table, "p/q")?.goneAt).toBeDefined();
    await applyAll(table, obs(30, [{ path: "p/q/new.md" }]));
    expect(find(table, "p/q")?.goneAt).toBeUndefined();
    expect(find(table, "p")?.goneAt).toBeUndefined();
  });

  test("an older observation of a file that has since gone does not bring its folder back", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "p/a.md" }]));
    await applyAll(table, obs(30, [], ["p/a.md"]));
    await applyAll(table, obs(20, [{ path: "p/a.md" }]));
    expect(find(table, "p/a.md")?.goneAt).toBe(30);
    expect(find(table, "p")?.goneAt).toBe(30);
  });

  test("a folder observed after the emptying observation is left alone", async () => {
    const table = memoryNodeTable();
    await applyAll(table, obs(10, [{ path: "p/a.md" }]));
    await applyAll(table, obs(40, [{ path: "p/b.md" }]));
    await applyAll(table, obs(30, [], ["p/b.md"]));
    expect(find(table, "p")?.goneAt).toBeUndefined();
  });
});

describe("the change log (phase 6)", () => {
  test("logs what appeared, changed and left, from every path that changes a file row, and nothing else", async () => {
    const table = memoryNodeTable();
    await applyAll(table, { at: 10, rows: [{ path: "a/x.md", etag: "1" }, { path: "a/y.md", etag: "1" }, { path: "b/z.md", etag: "1" }], gone: [] });
    // Re-seen as it was, and an older observation: nothing.
    await applyAll(table, { at: 20, rows: [{ path: "a/x.md", etag: "1" }], gone: [] });
    await applyAll(table, { at: 5, rows: [{ path: "a/x.md", etag: "0" }], gone: [] });
    // A new version and an exact departure. A file the observation does not name is left as it is.
    await applyAll(table, { at: 30, rows: [{ path: "a/x.md", etag: "2" }], gone: ["b/z.md"] });
    // Brought back.
    await applyAll(table, { at: 40, rows: [{ path: "b/z.md", etag: "1" }], gone: [] });
    expect(table.log()).toEqual([
      { path: "a/x.md", gone: false },
      { path: "a/y.md", gone: false },
      { path: "b/z.md", gone: false },
      { path: "a/x.md", gone: false },
      { path: "b/z.md", gone: true },
      { path: "b/z.md", gone: false },
    ]);
  });
});
