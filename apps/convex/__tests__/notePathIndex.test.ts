/**
 * `notePathIndex` (`lib/fileOps/search.ts`): every note path a caller may
 * link to, for the editor's `[[` completion and bare-link resolution. See
 * `docs/decisions/app-and-console.md`, "L1".
 *
 * It answers from the Convex tree's rows and nothing else (decided by the
 * owner, 2026-10-13: no reader of which notes exist reads the bucket, not
 * even as a fallback). It used to read the search index's docmap out of the
 * bucket; these cases pin that it no longer does:
 *
 *  - **A store that is not the tree's answers `null`, even fully indexed.**
 *    `null` is "not there yet", never `{ paths: [] }`: an empty array would
 *    tell the editor a workspace with notes in it has none.
 *  - **The rows never offer `privacy.md` or plumbing keys**, and a team
 *    caller never receives a private note's path. The clearance cases in
 *    full live in `nodes/servedReaders.test.ts`, "link completion".
 *
 * Sabotage: put the docmap branch back in `notePathIndex` and the "indexed
 * bucket" case fails; drop both the `isIndexableNote` and `isPlumbing`
 * filters and the plumbing case fails (either one alone still holds it).
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, maintainSearchIndex, notePathIndex } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { nodesPagedStore } from "../functions/lib/nodes/manifestStore";
import { privacyMirrorOf } from "./privacyMirrorOf.helpers";
import { compareKeys } from "../functions/lib/nodes/table";
import { renderPrivacyManifest, setFolderVisibility, setVisibility } from "./seededRules.helpers";

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/README.md", "# Projects\n");
  store.seed("1-projects/shared-plan.md", "# Shared plan\n");
  store.seed("1-projects/pay.md", "# Pay\n\nConfidential.\n");
  store.seed("2-areas/README.md", "# Areas\n");
  return store;
}

async function shareProjects(store: FileStore): Promise<void> {
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: clearanceOf("private") });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: clearanceOf("private") });
}

/** Run maintenance to convergence, the way `searchContext` schedules it. */
async function indexed(store: FileStore): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) {
    const maintained = await maintainSearchIndex(store);
    if (maintained.complete) break;
  }
}

/** The tree's store over this bucket: its rows as the tree holds them, and its rules mirror. */
async function served(store: MemoryStore & FileStore): Promise<FileStore> {
  const listing = await store.list({ limit: 10_000 });
  const rows = (listing.objects ?? [])
    .map((object: { key: string }) => ({ path: object.key }))
    .sort((a: { path: string }, b: { path: string }) => compareKeys(a.path, b.path));
  return nodesPagedStore(store, async () => ({ rows, cursor: null }), await privacyMirrorOf(store), []);
}

describe("notePathIndex", () => {
  test("a bucket with no index at all answers null, never an empty list", async () => {
    const store = bucket();
    expect(await notePathIndex(store, clearanceOf("private"))).toBeNull();
  });

  test("an indexed bucket still answers null: the search index's docmap is not read", async () => {
    const store = bucket();
    await indexed(store);
    expect(await notePathIndex(store, clearanceOf("private"))).toBeNull();
  });

  test("from the tree's rows: every note the owner can see, never privacy.md or plumbing", async () => {
    const store = bucket();
    store.seed(".context/routines/digest.md", "# Plumbing, not a note\n");
    await indexed(store);
    const found = await notePathIndex(await served(store), clearanceOf("private"));
    expect([...found!.paths].sort()).toEqual([
      "1-projects/README.md",
      "1-projects/pay.md",
      "1-projects/shared-plan.md",
      "2-areas/README.md",
      "index.md",
    ]);
    expect(found!.paths).not.toContain(PRIVACY_KEY);
    expect(found!.paths.some((path) => path.startsWith(".context/") || path.startsWith(".index/"))).toBe(false);
  });

  test("a team caller does not receive a private note's path", async () => {
    const store = bucket();
    await shareProjects(store);
    const asTeam = await notePathIndex(await served(store), clearanceOf("team"));
    expect(JSON.stringify(asTeam)).not.toContain("pay.md");
    expect(asTeam!.paths).toContain("1-projects/shared-plan.md");
  });
});
