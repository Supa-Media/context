/**
 * The keyed-row rules of the tree (`observe.ts`, `table.ts`), over the
 * in-memory table. A keyed row's bytes live at its `storageKey` and nowhere
 * else; the path object the bucket still holds is a frozen old copy. Two
 * kinds of observation may touch the tree:
 *
 * - a **bucket** observation (a listing, a re-check, a move worker) looks at
 *   path objects, so it never changes a keyed row and never adopts a path
 *   that has no row in a keyed workspace;
 * - a **seam** observation (the store reporting its own keyed writes) carries
 *   `noteId` and `storageKey` on every row, and is the only thing that writes
 *   a keyed row.
 *
 * Each case below fails if its guard in `observe.ts` is removed.
 */

import { describe, expect, test } from "vitest";
import { applyObservation, pruneUnobserved } from "../../functions/lib/nodes/observe";
import { nodeSweepDue, type NodeRow, type NodeTreeState, type Observation, type StoredNode } from "../../functions/lib/nodes/table";
import { applyAll, memoryNodeTable } from "../nodeTable.helpers";

const NOTE_A = "0190a000-0000-7000-8000-00000000000a";
const NOTE_B = "0190a000-0000-7000-8000-00000000000b";
const NOTE_C = "0190a000-0000-7000-8000-00000000000c";
const keyFor = (noteId: string) => `notes/${noteId}.md`;

function bucket(at: number, rows: { path: string; etag?: string; size?: number }[] = [], extra: Partial<Observation> = {}): Observation {
  return { at, rows, gone: [], vanishedUnder: [], ...extra };
}

/** A seam observation for one keyed write of `path` under `noteId`. */
function seam(at: number, path: string, noteId: string, etag: string): Observation {
  const row: NodeRow = { path, etag, size: 1, keyed: { noteId, storageKey: keyFor(noteId) } };
  return { at, rows: [row], gone: [], vanishedUnder: [], source: "seam" };
}

function seamGone(at: number, path: string): Observation {
  return { at, rows: [], gone: [path], vanishedUnder: [], source: "seam" };
}

function find(table: { rows(): StoredNode[] }, path: string): StoredNode | undefined {
  return table.rows().find((node) => node.path === path);
}

/** A keyed row at `path` under `noteId`, written at `at`. */
async function keyedRow(table: ReturnType<typeof memoryNodeTable>, path: string, noteId: string, at: number, etag = "k1") {
  await applyAll(table, seam(at, path, noteId, etag));
  return find(table, path) as StoredNode;
}

describe("bucket observations never change a keyed row", () => {
  test("a listing of the path object leaves the keyed row's etag, noteId and observation time alone", async () => {
    const table = memoryNodeTable();
    await keyedRow(table, "1-projects/a.md", NOTE_A, 10);

    await applyAll(table, bucket(20, [{ path: "1-projects/a.md", etag: "frozen-path-copy" }]));

    expect(find(table, "1-projects/a.md")).toMatchObject({ etag: "k1", observedAt: 10, noteId: NOTE_A, storageKey: keyFor(NOTE_A) });
  });

  test("a gone observation of the path does not tombstone a keyed row", async () => {
    const table = memoryNodeTable();
    await keyedRow(table, "1-projects/a.md", NOTE_A, 10);

    await applyAll(table, bucket(20, [], { gone: ["1-projects/a.md"] }));

    expect(find(table, "1-projects/a.md")?.goneAt).toBeUndefined();
  });

  test("a vanish scan of its folder does not tombstone a keyed row, but still tombstones an unkeyed sibling", async () => {
    const table = memoryNodeTable();
    await keyedRow(table, "1-projects/keyed.md", NOTE_A, 10);
    await applyAll(table, bucket(10, [{ path: "1-projects/plain.md", etag: "p" }]));

    await applyAll(table, bucket(20, [], { vanishedUnder: ["1-projects/"] }));

    expect(find(table, "1-projects/keyed.md")?.goneAt).toBeUndefined();
    expect(find(table, "1-projects/plain.md")?.goneAt).toBe(20);
  });

  test("a bucket listing does not revive a keyed row that is gone", async () => {
    const table = memoryNodeTable();
    await keyedRow(table, "1-projects/a.md", NOTE_A, 10);
    await applyAll(table, seamGone(20, "1-projects/a.md"));

    await applyAll(table, bucket(30, [{ path: "1-projects/a.md", etag: "frozen" }]));

    expect(find(table, "1-projects/a.md")).toMatchObject({ goneAt: 20, noteId: NOTE_A, etag: "k1" });
  });

  test("pruneUnobserved never removes a keyed row, even one no observation has seen since the sweep began", async () => {
    const table = memoryNodeTable();
    await keyedRow(table, "1-projects/a.md", NOTE_A, 10);
    await applyAll(table, bucket(15, [{ path: "1-projects/plain.md", etag: "p" }]));

    const pruned = await pruneUnobserved(table, 1_000);

    expect(pruned.more).toBe(false);
    expect(find(table, "1-projects/a.md")).toBeDefined();
    // The unkeyed row nobody saw is still pruned: the rule protects keyed rows only.
    expect(find(table, "1-projects/plain.md")).toBeUndefined();
  });

  test("pruneUnobserved terminates when keyed rows are the only old rows (they are not counted as work)", async () => {
    const table = memoryNodeTable();
    for (let index = 0; index < 3; index += 1) {
      await keyedRow(table, `1-projects/k${index}.md`, `${NOTE_A.slice(0, -1)}${index}`, 10);
    }

    const pruned = await pruneUnobserved(table, 1_000);

    expect(pruned.more).toBe(false);
    expect(pruned.removedFiles).toBe(0);
    expect(table.rows().filter((node) => node.kind === "file")).toHaveLength(3);
  });
});

describe("a keyed workspace adopts nothing from the bucket", () => {
  test("a bucket row with no row in a keyed workspace is not inserted, and no folder is made for it", async () => {
    const table = memoryNodeTable();

    await applyAll(table, bucket(10, [{ path: "new/folder/a.md", etag: "e" }], { keyedWorkspace: true }));

    expect(table.rows()).toEqual([]);
  });

  test("the same bucket row is adopted in a workspace that is not keyed, with its folders", async () => {
    const table = memoryNodeTable();

    await applyAll(table, bucket(10, [{ path: "new/folder/a.md", etag: "e" }], { keyedWorkspace: false }));

    expect(find(table, "new/folder/a.md")).toMatchObject({ kind: "file", etag: "e" });
    expect(find(table, "new/folder")).toMatchObject({ kind: "folder" });
  });

  test("a folder marker key is its own file row, named empty, under the folder it marks, in a workspace that is not keyed", async () => {
    const table = memoryNodeTable();

    await applyAll(table, bucket(10, [{ path: "a/", etag: "marker" }], { keyedWorkspace: false }));

    expect(find(table, "a")).toMatchObject({ kind: "folder" });
    expect(find(table, "a/")).toMatchObject({ kind: "file", name: "" });
  });

  test("an unkeyed row in a keyed workspace is still observed as it always was", async () => {
    const table = memoryNodeTable();
    await applyAll(table, bucket(10, [{ path: "plain.md", etag: "old" }]));

    await applyAll(table, bucket(20, [{ path: "plain.md", etag: "new" }], { keyedWorkspace: true }));

    expect(find(table, "plain.md")).toMatchObject({ etag: "new", observedAt: 20 });
  });
});

describe("seam observations write keyed rows", () => {
  test("a seam write with no row at its path inserts a keyed file under the given noteId and storageKey, with its folders", async () => {
    const table = memoryNodeTable();

    const result = await applyObservationOnce(table, seam(10, "1-projects/x/a.md", NOTE_A, "k1"));

    expect(result.taken).toEqual([]);
    expect(find(table, "1-projects/x/a.md")).toMatchObject({
      kind: "file",
      name: "a.md",
      etag: "k1",
      size: 1,
      observedAt: 10,
      noteId: NOTE_A,
      storageKey: keyFor(NOTE_A),
    });
    expect(find(table, "1-projects/x")).toMatchObject({ kind: "folder" });
    expect(table.log()).toEqual([{ path: "1-projects/x/a.md", gone: false }]);
  });

  test("a seam write to a live keyed row with the same noteId takes the newer version and keeps the id", async () => {
    const table = memoryNodeTable();
    await keyedRow(table, "a.md", NOTE_A, 10, "k1");

    const newer = await applyObservationOnce(table, seam(20, "a.md", NOTE_A, "k2"));
    await applyObservationOnce(table, seam(5, "a.md", NOTE_A, "k0"));

    expect(newer.taken).toEqual([]);
    expect(find(table, "a.md")).toMatchObject({ etag: "k2", observedAt: 20, noteId: NOTE_A, storageKey: keyFor(NOTE_A) });
    expect(table.log().filter((change) => change.path === "a.md")).toHaveLength(2);
  });

  test("a seam write over a gone row re-creates it as a new note: new noteId and storageKey, idCopy and keyedFrom cleared", async () => {
    const table = memoryNodeTable();
    const old = await keyedRow(table, "a.md", NOTE_A, 10, "k1");
    await table.patch(old.id, { keyedFrom: { pathEtag: "p1", keyEtag: "k1" }, idCopy: { key: "notes/x.md", etag: "k1", copiedAt: 11 } });
    await applyAll(table, seamGone(20, "a.md"));

    const result = await applyObservationOnce(table, seam(30, "a.md", NOTE_B, "k9"));

    expect(result.taken).toEqual([]);
    const node = find(table, "a.md");
    expect(node).toMatchObject({ noteId: NOTE_B, storageKey: keyFor(NOTE_B), etag: "k9", observedAt: 30 });
    expect(node?.goneAt).toBeUndefined();
    expect(node?.idCopy).toBeUndefined();
    expect(node?.keyedFrom).toBeUndefined();
  });

  test("a seam write over a gone unkeyed row clears its id copy as well", async () => {
    const table = memoryNodeTable();
    await applyAll(table, bucket(10, [{ path: "a.md", etag: "p" }]));
    const plain = find(table, "a.md") as StoredNode;
    await table.patch(plain.id, { idCopy: { key: "notes/x.md", etag: "p", copiedAt: 11 } });
    await applyAll(table, bucket(15, [], { gone: ["a.md"] }));

    const result = await applyObservationOnce(table, seam(30, "a.md", NOTE_C, "k1"));

    expect(result.taken).toEqual([]);
    expect(find(table, "a.md")).toMatchObject({ noteId: NOTE_C, goneAt: undefined });
    expect(find(table, "a.md")?.idCopy).toBeUndefined();
  });

  test("a seam write older than the tombstone over its row does not re-create it", async () => {
    const table = memoryNodeTable();
    await keyedRow(table, "a.md", NOTE_A, 10, "k1");
    await applyAll(table, seamGone(20, "a.md"));

    const result = await applyObservationOnce(table, seam(15, "a.md", NOTE_B, "k0"));

    expect(result.taken).toEqual([]);
    expect(find(table, "a.md")).toMatchObject({ noteId: NOTE_A, goneAt: 20 });
  });
});

describe("a seam write that cannot land is taken, and changes nothing", () => {
  test("a live unkeyed file at the path is taken", async () => {
    const table = memoryNodeTable();
    await applyAll(table, bucket(10, [{ path: "a.md", etag: "p" }]));
    const before = table.rows();

    const result = await applyObservationOnce(table, seam(20, "a.md", NOTE_A, "k1"));

    expect(result.taken).toEqual(["a.md"]);
    expect(table.rows()).toEqual(before);
    expect(table.log()).toEqual([{ path: "a.md", gone: false }]);
  });

  test("a live keyed file under another noteId is taken", async () => {
    const table = memoryNodeTable();
    await keyedRow(table, "a.md", NOTE_A, 10, "k1");
    const before = table.rows();

    const result = await applyObservationOnce(table, seam(20, "a.md", NOTE_B, "k2"));

    expect(result.taken).toEqual(["a.md"]);
    expect(table.rows()).toEqual(before);
  });

  test("a seam write at a folder-marker key is taken: a note's key is never a marker", async () => {
    const table = memoryNodeTable();
    const before = table.rows();

    const result = await applyObservationOnce(table, seam(20, "a/", NOTE_A, "k1"));

    expect(result.taken).toEqual(["a/"]);
    expect(table.rows()).toEqual(before);
  });

  test("a folder at the path is taken", async () => {
    const table = memoryNodeTable();
    await applyAll(table, bucket(10, [{ path: "docs/x/y.md", etag: "p" }]));
    const before = table.rows();

    const result = await applyObservationOnce(table, seam(20, "docs/x", NOTE_A, "k1"));

    expect(result.taken).toEqual(["docs/x"]);
    expect(table.rows()).toEqual(before);
  });

  test("a folder retired as empty gives its name to a note, which is never taken by its tombstone", async () => {
    const table = memoryNodeTable();
    await applyAll(table, bucket(10, [{ path: "docs/x/y.md", etag: "p" }]));
    await applyAll(table, bucket(15, [], { gone: ["docs/x/y.md"] }));
    expect(find(table, "docs/x")?.goneAt).toBe(15);

    const result = await applyObservationOnce(table, seam(20, "docs/x", NOTE_A, "k1"));

    expect(result.taken).toEqual([]);
    expect(find(table, "docs/x")).toMatchObject({ kind: "file", noteId: NOTE_A, storageKey: keyFor(NOTE_A) });
  });

  test("a file sitting in a folder's place in the chain is taken, and no folder is created above it", async () => {
    const table = memoryNodeTable();
    await applyAll(table, bucket(10, [{ path: "f.md", etag: "p" }]));
    const before = table.rows();

    const result = await applyObservationOnce(table, seam(20, "f.md/child.md", NOTE_A, "k1"));

    expect(result.taken).toEqual(["f.md/child.md"]);
    expect(table.rows()).toEqual(before);
  });

  test("a file blocking a folder further up stops the write before any folder above it is made", async () => {
    const table = memoryNodeTable();
    // A file row whose folder row is missing (the state a pruned folder leaves): `p` has no row, `p/q` does.
    await table.insert({ path: "p/q", name: "q", kind: "file", etag: "p", observedAt: 10 });
    const before = table.rows();

    const result = await applyObservationOnce(table, seam(20, "p/q/child.md", NOTE_A, "k1"));

    expect(result.taken).toEqual(["p/q/child.md"]);
    expect(table.rows()).toEqual(before);
  });
});

describe("seam gone observations tombstone keyed rows only", () => {

  test("a seam gone tombstones the keyed row, and retires its emptied folder as a bucket gone does", async () => {
    const table = memoryNodeTable();
    await keyedRow(table, "lonely/a.md", NOTE_A, 10, "k1");

    await applyAll(table, seamGone(20, "lonely/a.md"));

    expect(find(table, "lonely/a.md")?.goneAt).toBe(20);
    expect(find(table, "lonely")?.goneAt).toBe(20);
  });

  test("a seam gone leaves an unkeyed row at the same path alone", async () => {
    const table = memoryNodeTable();
    await applyAll(table, bucket(10, [{ path: "plain.md", etag: "p" }]));

    await applyAll(table, seamGone(20, "plain.md"));

    expect(find(table, "plain.md")?.goneAt).toBeUndefined();
  });

  test("a seam observation ignores vanishedUnder: an unkeyed sibling under the prefix stays", async () => {
    const table = memoryNodeTable();
    await applyAll(table, bucket(10, [{ path: "1-projects/plain.md", etag: "p" }]));

    await applyAll(table, { at: 20, rows: [], gone: [], vanishedUnder: ["1-projects/"], source: "seam" });

    expect(find(table, "1-projects/plain.md")?.goneAt).toBeUndefined();
  });
});

describe("nodeSweepDue in a keyed workspace", () => {
  const ready: NodeTreeState = { status: "ready", dirty: true, files: 3, sweptAt: 0 };

  test("a keyed workspace is never due, however dirty or stale its tree", () => {
    expect(nodeSweepDue(ready, 10 * 60 * 60_000, true)).toBe(false);
    expect(nodeSweepDue(null, 0, true)).toBe(false);
  });

  test("a workspace that is not keyed is due as it was", () => {
    expect(nodeSweepDue(ready, 10 * 60 * 60_000)).toBe(true);
    expect(nodeSweepDue(ready, 10 * 60 * 60_000, false)).toBe(true);
  });
});

/** One observation applied to completion, returning its result (`taken` is read from the last call). */
async function applyObservationOnce(table: ReturnType<typeof memoryNodeTable>, observation: Observation) {
  return await applyObservation(table, observation);
}
