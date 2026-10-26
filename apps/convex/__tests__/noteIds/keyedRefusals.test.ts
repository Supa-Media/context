/**
 * The vault replacement's clear (`lib/fileOps/vaultImport.ts`,
 * `docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * Every workspace keeps its notes under their ids: a note's bytes are at
 * `notes/<noteId>.md` and the object at its path is a frozen copy. A clear of
 * the bucket deletes by key and leaves the tree's rows naming notes that are
 * gone, so it is refused in every workspace, before anything is listed.
 *
 * Sabotage, confirmed to fail the case here: let the clear list and delete
 * again (the body it had before 2026-10-26): the bucket is emptied.
 */
import { describe, expect, test } from "vitest";
import { clearVaultBatch } from "../../functions/lib/fileOps/vaultImport";
import { memoryStore } from "../storeStub.helpers";
import type { Store } from "../nodes/moveFixture.helpers";

describe("the vault replacement's clear", () => {
  test("is refused before any object is listed or deleted, counting or not", async () => {
    const store = memoryStore() as Store;
    store.seed("notes/0192f1a2-3b4c-7d5e-8f60-000000000001.md", "live\n");
    store.seed("1-projects/a.md", "frozen\n");
    const before = store.snapshot();
    let listed = 0;
    const list = store.list.bind(store);
    store.list = async (...args: Parameters<Store["list"]>) => {
      listed += 1;
      return await list(...args);
    };
    await expect(clearVaultBatch(store, false)).rejects.toMatchObject({ code: "KEYED_WORKSPACE" });
    await expect(clearVaultBatch(store, true)).rejects.toMatchObject({ code: "KEYED_WORKSPACE" });
    expect(store.snapshot()).toEqual(before);
    expect(listed).toBe(0);
  });
});
