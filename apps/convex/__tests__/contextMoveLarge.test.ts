/**
 * A file too large to cross between two workspaces stays where it is, named,
 * instead of wedging every batch after it (project file `move-engine/plan.md`,
 * step D). A batch crosses the 16 MiB argument limit twice and is read whole
 * in one action; carrying such a file in parts waits on a seal that works in
 * parts for a managed destination.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the HEAD size check and the sized case reads the whole file;
 *  - drop the after-read check and the store without HEAD carries it.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { CONTEXT_MOVE_OBJECT_MAX_BYTES, exportContextMoveBatch, type FileStore } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifestForFolders } from "../functions/lib/scaffold";
import { memoryStore } from "./storeStub.helpers";

const OWNER = clearanceOf("private", []);

function bucket() {
  const store = memoryStore({ conditional: true });
  store.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(["1-projects"], "personal"));
  store.seed("1-projects/acme/plan.md", "# Plan\n");
  store.seed("1-projects/acme/talk.mp4", new Uint8Array(CONTEXT_MOVE_OBJECT_MAX_BYTES + 1));
  return store;
}

const exportFrom = (store: unknown) =>
  exportContextMoveBatch(store as FileStore, { from: "1-projects/acme", to: "work/acme", clearance: OWNER });

describe("a file too large to cross between workspaces", () => {
  test("is sized before it is read, left in place and named; the rest of the folder moves", async () => {
    const store = bucket();
    const reads: string[] = [];
    const sized = Object.assign(Object.create(store), {
      async head(key: string) {
        const value = store.objects.get(key);
        return value ? { etag: value.etag, size: value.bytes.length } : null;
      },
      async get(key: string) {
        reads.push(key);
        return await store.get(key);
      },
    });
    const exported = await exportFrom(sized);
    expect(exported.objects.map((object) => object.source)).toEqual(["1-projects/acme/plan.md"]);
    expect(exported.skipped).toEqual([{ path: "1-projects/acme/talk.mp4", reason: "too_large" }]);
    expect(reads).not.toContain("1-projects/acme/talk.mp4");
  });

  test("a store that cannot say a size still leaves it, once read", async () => {
    const exported = await exportFrom(bucket());
    expect(exported.objects.map((object) => object.source)).toEqual(["1-projects/acme/plan.md"]);
    expect(exported.skipped).toEqual([{ path: "1-projects/acme/talk.mp4", reason: "too_large" }]);
  });
});
