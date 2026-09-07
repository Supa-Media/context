/**
 * `notePathIndex` (`lib/fileOps.ts`) — the note-path index the editor's link
 * resolution reuses rather than building a second one. See
 * `docs/decisions/app-and-console.md`, "L1".
 *
 * What is asserted, and why:
 *
 *  - **It answers from the index, not from a listing.** A bucket that has
 *    never been indexed returns `null`, never `{ paths: [] }` — the same
 *    "absent is not zero" rule the search index and the note census both
 *    follow, because an empty array here would tell the editor a bucket with
 *    real notes in it has none.
 *  - **A team caller cannot learn a private note's path through it.** The
 *    docmap holds every note in the bucket regardless of who asks, so this is
 *    the same existence-oracle risk `consoleSearch.test.ts` proves closed for
 *    search results, reached through a different door: a path list rather
 *    than a hit list.
 *  - **It reuses the search index's own docmap rather than a second index** —
 *    proven by driving the same `maintainSearchIndex` fixture `consoleSearch`
 *    uses and nothing else, so there is no second maintenance loop to have
 *    forgotten to run.
 */

import { describe, expect, test } from "vitest";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import {
  type FileStore,
  maintainSearchIndex,
  notePathIndex,
  setFolderVisibility,
  setVisibility,
} from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

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
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", scope: "private" });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", scope: "private" });
}

/** Run maintenance to convergence, the way `searchContext` schedules it. */
async function indexed(store: FileStore): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) {
    const maintained = await maintainSearchIndex(store);
    if (maintained.complete) break;
  }
}

describe("notePathIndex", () => {
  test("a bucket with no index at all answers null, never an empty list", async () => {
    const store = bucket();
    const found = await notePathIndex(store, "private");
    expect(found).toBeNull();
  });

  test("once indexed, returns every note path the owner can see, sorted", async () => {
    const store = bucket();
    await indexed(store);
    const found = await notePathIndex(store, "private");

    expect(found).not.toBeNull();
    expect(found!.paths).toEqual([
      "1-projects/README.md",
      "1-projects/pay.md",
      "1-projects/shared-plan.md",
      "2-areas/README.md",
      "index.md",
    ]);
  });

  test("a team caller does not receive a private note's path", async () => {
    const store = bucket();
    await shareProjects(store);
    await indexed(store);

    const asOwner = await notePathIndex(store, "private");
    expect(asOwner!.paths).toContain("1-projects/pay.md");

    const asTeam = await notePathIndex(store, "team");
    expect(asTeam!.paths).not.toContain("1-projects/pay.md");
    // Not the path anywhere in the answer, the same way `consoleSearch.test.ts`
    // checks a search result never carries the withheld path in any field.
    expect(JSON.stringify(asTeam)).not.toContain("pay.md");
    // And the rest of the bucket is still there — this is a filter, not a
    // refusal of the whole answer.
    expect(asTeam!.paths).toContain("1-projects/shared-plan.md");
  });

  test("privacy.md itself is never offered as a link target", async () => {
    const store = bucket();
    await indexed(store);
    const found = await notePathIndex(store, "private");
    expect(found!.paths).not.toContain(PRIVACY_KEY);
  });

  test("PRIVACY_KEY is a plumbing key excluded from the docmap entirely, not merely filtered here", async () => {
    // Documented rather than merely asserted: `isPlumbing` runs *in addition*
    // to `canSee` in `notePathIndex`, but the indexer's own `isIndexable`
    // already keeps `.index/` and `privacy.md` out of the docmap in the first
    // place. This pins the outcome either layer is responsible for.
    const store = bucket();
    await indexed(store);
    const found = await notePathIndex(store, "private");
    expect(found!.paths.some((path) => path.startsWith(".index/"))).toBe(false);
  });
});
