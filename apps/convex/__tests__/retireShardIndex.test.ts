/**
 * The bucket's shard index is deleted from a context its search database
 * serves, on the database's daily check, and nothing else is.
 *
 * Decided by the owner, 2026-10-17 ("Yes, all of it": search on the database
 * only, and the index files in storage deleted).
 *
 * ## Sabotage record
 *
 * Temporary local edits, reverted:
 *
 *   `isRetiredShardKey` takes any key under `.context/search/`     "search by meaning's state" fails
 *   the cap check removed                                           "a big index goes a batch at a link" fails
 *   `runPrunePass` ignoring `SHARD_INDEX_RETIRE`                    "the switch stops the deletes" fails
 *   `runPrunePass` not chaining while files are left                "a big index goes a batch at a link" fails
 */

import { afterEach, describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { FileStore } from "../functions/lib/fileOps";
import { isRetiredShardKey, RETIRE_DELETE_CAP, retireShardIndex } from "../functions/lib/fileOps/retireShardIndex";
import { runPrunePass } from "../functions/lib/filesFns/prunePass";
import { stubD1 } from "./searchBackfill.helpers";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";

const SHARD_FILES = [
  ".context/search/v2/manifest.json",
  ".context/search/v2/docmap.json",
  ".context/search/v2/shard-000.json",
  ".context/search/v2/shard-001.json",
  ".context/search/search-v1.json",
  ".index/v2/shard-000.json",
  ".index/search-v1.json",
];
const KEPT = [
  ".context/search/meaning/v1/state.json",
  ".index/meaning/v1/state.json",
  ".context/search/v2/meaning/state.json",
  ".context/audit/2026-10-17.jsonl",
  "1-projects/plan.md",
  "notes/0b3c5f7e-0000-4000-8000-000000000000.md",
];

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  for (const key of [...SHARD_FILES, ...KEPT]) store.seed(key, "{}");
  return store;
}

const keys = (store: MemoryStore) => [...store.objects.keys()].sort();

afterEach(() => {
  delete process.env.SHARD_INDEX_RETIRE;
});

describe("retiring the bucket's shard index", () => {
  test("its files go, at both places, and nothing else does", async () => {
    const store = bucket();
    expect(await retireShardIndex(store)).toEqual({ deleted: SHARD_FILES.length, more: false });
    expect(keys(store)).toEqual([...KEPT].sort());
    // Done once, there is nothing left to do.
    expect(await retireShardIndex(store)).toEqual({ deleted: 0, more: false });
  });

  test("search by meaning's state, and anything outside the index, is never on the list", () => {
    for (const key of KEPT) expect(isRetiredShardKey(key)).toBe(false);
    for (const key of [".context/search/v2/", ".context/search/", ".context/search/v2/../meaning/v1/state.json", "v2/shard-000.json"]) {
      expect(isRetiredShardKey(key)).toBe(false);
    }
    for (const key of SHARD_FILES) expect(isRetiredShardKey(key)).toBe(true);
  });

  test("a big index goes a batch at a link, and the daily check chains while some are left", async () => {
    const store = bucket();
    for (let n = 2; n < 12; n += 1) store.seed(`.context/search/v2/shard-${String(n).padStart(3, "0")}.json`, "{}");
    expect(await retireShardIndex(store, { cap: 5 })).toEqual({ deleted: 5, more: true });

    const d1 = stubD1();
    const scheduled: unknown[] = [];
    const ctx = { scheduler: { runAfter: async (...args: unknown[]) => scheduled.push(args) } } as unknown as ActionCtx;
    const args = { workspaceId: "w" as Id<"workspaces">, operation: { passes: 3 } };
    // More than one link deletes: this one stops at its cap and asks for the next.
    for (let n = 12; n < RETIRE_DELETE_CAP + 20; n += 1) store.seed(`.context/search/v2/shard-${String(n).padStart(3, "0")}.json`, "{}");
    await runPrunePass(ctx, args, store, d1.client, []);
    expect(scheduled).toHaveLength(1);
    await runPrunePass(ctx, { ...args, operation: { passes: 2 } }, store, d1.client, []);
    expect(keys(store)).toEqual([...KEPT].sort());
    // Everything fit in that link, so nothing follows it.
    expect(scheduled).toHaveLength(1);
  });

  test("the switch stops the deletes", async () => {
    process.env.SHARD_INDEX_RETIRE = "off";
    const store = bucket();
    const d1 = stubD1();
    const ctx = { scheduler: { runAfter: async () => {} } } as unknown as ActionCtx;
    await runPrunePass(ctx, { workspaceId: "w" as Id<"workspaces">, operation: { passes: 1 } }, store, d1.client, []);
    expect(keys(store)).toEqual([...SHARD_FILES, ...KEPT].sort());
  });

  test("a context its database does not serve keeps its index", async () => {
    const store = bucket();
    const ctx = { scheduler: { runAfter: async () => {} } } as unknown as ActionCtx;
    await runPrunePass(ctx, { workspaceId: "w" as Id<"workspaces">, operation: { passes: 1 } }, store, null, []);
    expect(keys(store)).toEqual([...SHARD_FILES, ...KEPT].sort());
  });
});
