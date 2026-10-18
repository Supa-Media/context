/**
 * Path-based file operations in a KEYED workspace (`lib/noteIds/keyedStore.ts`,
 * `docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * A keyed note's bytes are at `notes/<noteId>.md`; the object at its path is a
 * frozen copy. A listing of the bucket, a clear of it, a move out of it, or a
 * byte move by old name would act on the frozen copies, so each one is refused.
 * A workspace that is not keyed is unchanged, and every case below also runs
 * unkeyed.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop `refuseKeyedStore` from the vault clear: the keyed clear deletes the bucket;
 *  - list the bucket in a keyed context move: it plans the frozen copies (`contextMoveKeyed.test.ts` runs the move);
 *  - drop the move's keyed check: the keyed move walks the old name and moves frozen copies.
 */
import { describe, expect, test } from "vitest";
import { clearVaultBatch } from "../../functions/lib/fileOps/vaultImport";
import { planContextMoveBatch } from "../../functions/lib/fileOps/contextMoveExport";
import { attachWorkspaceKeyed, isKeyedStore, KEYED_REFUSAL } from "../../functions/lib/noteIds/keyedStore";
import { MOVE_FAILED_KEYED, runMoveWork } from "../../functions/lib/nodes/moveWork";
import { clearanceOf } from "../../functions/lib/clearance";
import { memoryStore } from "../storeStub.helpers";
import { type Store, fixture, start, bucketKeys } from "../nodes/moveFixture.helpers";

const OWNER = clearanceOf("private");

/** Mark a store keyed, as the barrier does for a keyed workspace: a question answered without a control plane. */
function keyed<T extends object>(store: T, answer = true): T {
  Object.defineProperty(store, "workspaceKeyed", { value: async () => answer, enumerable: false, configurable: true });
  return store;
}

/** A store whose bucket listing is counted, so a case can say it was never asked. */
function counted(store: Store) {
  const listed: string[] = [];
  const list = store.list.bind(store);
  store.list = async (options: { prefix?: string; cursor?: string; limit?: number }) => {
    listed.push(options?.prefix ?? "");
    return await list(options);
  };
  return listed;
}

describe("a keyed question", () => {
  test("is asked of the store, and an unasked store is not keyed", async () => {
    expect(await isKeyedStore(memoryStore())).toBe(false);
    expect(await isKeyedStore(keyed(memoryStore()))).toBe(true);
    expect(await isKeyedStore(keyed(memoryStore(), false))).toBe(false);
  });

  test("the barrier's attachment asks the control plane once per call, not once per use", async () => {
    let asked = 0;
    const store = memoryStore() as unknown as object;
    const ctx = {
      runQuery: async () => {
        asked += 1;
        return true;
      },
    };
    attachWorkspaceKeyed(ctx as never, "ws" as never, store);
    expect(await isKeyedStore(store)).toBe(true);
    expect(await isKeyedStore(store)).toBe(true);
    expect(asked).toBe(1);
  });
});

describe("the vault replacement's clear in a keyed workspace", () => {
  test("is refused before any object is deleted", async () => {
    const store = keyed(memoryStore() as Store);
    store.seed("notes/0192f1a2-3b4c-7d5e-8f60-000000000001.md", "live\n");
    store.seed("1-projects/a.md", "frozen\n");
    const before = store.snapshot();
    await expect(clearVaultBatch(store, false)).rejects.toMatchObject({ code: "KEYED_WORKSPACE" });
    await expect(clearVaultBatch(store, true)).rejects.toMatchObject({ code: "KEYED_WORKSPACE" });
    expect(store.snapshot()).toEqual(before);
  });

  test("an unkeyed workspace is cleared as before", async () => {
    const store = memoryStore() as Store;
    store.seed("1-projects/a.md", "# A\n");
    const result = await clearVaultBatch(store, false);
    expect(result.mode).toBe("deleted");
    expect(result.objects).toBe(1);
  });
});

describe("a context move out of a keyed workspace", () => {
  test("lists what moves from the tree's names, never the bucket's frozen paths", async () => {
    const store = keyed(memoryStore() as Store);
    store.seed("1-projects/launch/frozen.md", "# Frozen copy\n");
    const tree = memoryStore() as Store;
    tree.seed("1-projects/launch/brief.md", "# Brief\n");
    Object.defineProperty(store, "treeListing", { value: { list: tree.list.bind(tree) }, enumerable: false, configurable: true });
    const listed = counted(store);
    const planned = await planContextMoveBatch(store, {
      from: "1-projects/launch",
      to: "2-areas/launch",
      clearance: OWNER,
      maxObjectBytes: 1024,
    });
    expect(planned.objects.map((object) => object.source)).toEqual(["1-projects/launch/brief.md"]);
    expect(listed).toEqual([]);
  });
});

describe("a queued move by old name in a keyed workspace", () => {
  test("is refused, with its reason, before any object is walked or moved", async () => {
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    const before = bucketKeys(f.store);
    keyed(f.store);
    await runMoveWork(f.ctx, f.ws, f.store);
    const rows = (await f.t.run(async (ctx) =>
      await ctx.db.query("moveQueue").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).collect())) as unknown as {
      lastError?: string;
    }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.lastError).toBe(MOVE_FAILED_KEYED);
    expect(bucketKeys(f.store)).toEqual(before);
  });
});
