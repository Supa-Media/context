/**
 * Path-based file operations in a KEYED workspace (`lib/noteIds/keyedStore.ts`,
 * `docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * A keyed note's bytes are at `notes/<noteId>.md`; the object at its path is a
 * frozen copy. A clear of the bucket would act on the frozen copies, so it is refused.
 * A workspace that is not keyed is unchanged, and every case below also runs
 * unkeyed.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop `refuseKeyedStore` from the vault clear: the keyed clear deletes the bucket;
 */
import { describe, expect, test } from "vitest";
import { clearVaultBatch } from "../../functions/lib/fileOps/vaultImport";
import { attachWorkspaceKeyed, isKeyedStore } from "../../functions/lib/noteIds/keyedStore";
import { memoryStore } from "../storeStub.helpers";
import type { Store } from "../nodes/moveFixture.helpers";

/** Mark a store keyed, as the barrier does for a keyed workspace: a question answered without a control plane. */
function keyed<T extends object>(store: T, answer = true): T {
  Object.defineProperty(store, "workspaceKeyed", { value: async () => answer, enumerable: false, configurable: true });
  return store;
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
