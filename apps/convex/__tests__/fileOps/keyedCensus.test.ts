/**
 * The search census in a keyed workspace, as the control plane builds it
 * (`lib/fileOps/projection.ts` `listingCensus`, which the fast-search copy and
 * search by meaning both read; `docs/decisions/search.md`,
 * `docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * Once a workspace is keyed, the bucket lists `notes/<uuid>.md`, not the names,
 * so a census taken from it names notes by uuid and the copy would file a
 * uuid as a note. The barrier attaches the Convex tree as `treeListing`, and
 * the census reads that. The tree's rows carry the names and the etags a keyed
 * row holds (the key's own).
 *
 * Sabotage, each confirmed to fail a case here:
 *  - the census reads the bucket even with a tree attached: the names case fails;
 *  - a tree that is loading falls back to the bucket: the loading case fails.
 */
import { describe, expect, test, vi } from "vitest";
import { listingCensus, pruneSearchIndex } from "../../functions/lib/fileOps/projection";
import type { FileStore } from "../../functions/lib/fileOps/store";
import { createSearchBudget } from "../../../mcp/src/search/maintain.js";
import { idKeyFor } from "../../../mcp/src/store/noteIdKeys.js";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";

const NOTES = [
  { path: "1-projects/alpha.md", noteId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51", body: "# Alpha\n\nA PANGOLIN sighting.\n" },
  { path: "2-areas/beta.md", noteId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52", body: "# Beta\n\nA quiet note.\n" },
];

/** A keyed workspace's store: each note's bytes at its id key, the tree's rows naming them. */
function keyedStore(options: { loading?: boolean } = {}) {
  const store = memoryStore() as MemoryStore & FileStore;
  const rows = NOTES.map(({ path, noteId, body }) => {
    const key = idKeyFor(noteId, path);
    store.seed(key, body);
    return { path, key, etag: `etag-${noteId}`, size: body.length };
  });
  const names = {
    list: async ({ prefix = "", delimiter }: { prefix?: string; delimiter?: string } = {}) => {
      if (options.loading) throw new Error("the tree is still loading");
      const inside = rows.filter((row) => row.path.startsWith(prefix));
      if (delimiter !== "/") {
        return {
          objects: inside.map((row) => ({ key: row.path, etag: row.etag, size: row.size })),
          delimitedPrefixes: [],
          truncated: false,
        };
      }
      const objects: { key: string; etag: string; size: number }[] = [];
      const folders = new Set<string>();
      for (const row of inside) {
        const rest = row.path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) objects.push({ key: row.path, etag: row.etag, size: row.size });
        else folders.add(`${prefix}${rest.slice(0, slash + 1)}`);
      }
      return { objects, delimitedPrefixes: [...folders], truncated: false };
    },
  };
  Object.defineProperty(store, "treeListing", { value: names, enumerable: false, configurable: true });
  return { store, rows };
}

describe("the census of a keyed workspace", () => {
  test("names the notes by their tree names and row etags, never by the bucket's uuid keys", async () => {
    const { store, rows } = keyedStore();
    const listed = await listingCensus(store, createSearchBudget(100));
    expect(listed).not.toBeNull();
    expect([...listed!.census.keys()].sort()).toEqual(NOTES.map((note) => note.path).sort());
    for (const row of rows) expect(listed!.census.get(row.path)).toBe(row.etag);
  });

  test("never lists the bucket while the tree is attached", async () => {
    const { store } = keyedStore();
    const bucketList = vi.spyOn(store, "list");
    await listingCensus(store, createSearchBudget(100));
    expect(bucketList).not.toHaveBeenCalled();
  });

  test("a tree that is still loading gives no census, and the bucket is not listed instead", async () => {
    const { store } = keyedStore({ loading: true });
    const bucketList = vi.spyOn(store, "list");
    expect(await listingCensus(store, createSearchBudget(100))).toBeNull();
    expect(bucketList).not.toHaveBeenCalled();
  });

  test("pruning a keyed workspace's search rows deletes none of them, since every note is in the census", async () => {
    const { store } = keyedStore();
    // The rows the search database holds: the notes, by name, as the copy filed them.
    const client = {
      query: async () => NOTES.map(({ path }) => ({ path })),
      runAll: vi.fn(async () => ({ applied: 0, skipped: false })),
    };
    // Enough budget for the listing and for asking after every row by name: a pass cut short proves nothing.
    const pruned = await pruneSearchIndex(store, client, { budget: 1000 });
    expect(pruned).toEqual({ deleted: 0, checked: true });
    expect(client.runAll).not.toHaveBeenCalled();
  });
});
