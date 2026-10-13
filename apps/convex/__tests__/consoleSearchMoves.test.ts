/**
 * The console's search while a queued folder move copies (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`). Split from
 * `consoleSearch.test.ts`, whose bucket it reuses.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, maintainSearchIndex, searchNotes, setFolderVisibility } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { withPendingMoves } from "../../mcp/src/moves/queued.js";

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/shared-plan.md", "# Shared plan\n\nThe quokkaplan ships in March.\n");
  store.seed("2-areas/health.md", "# Health\n\nA quokkaplan review each spring.\n");
  return store;
}

async function shareProjects(store: FileStore): Promise<void> {
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: clearanceOf("private") });
}

describe("the console's search while a queued folder move copies", () => {
  /**
   * Phase 4 of `docs/decisions/app-and-console/convex-tree.md`: the bucket
   * still holds `1-projects/` while every screen draws it at `2-areas/moved/`.
   * The store the barrier hands a search reads through the pending moves
   * (`storeWithMoves`), and no answer may name a path no screen shows, or
   * show a team member a note at a name the move has taken somewhere private.
   * Sabotage: drop the `atTreeNames` call in `searchNotes` and the old name
   * is answered; read snippets with `store.get` again and the moved note is
   * not found at all.
   */
  async function movingProjects(to: string) {
    const store = bucket();
    await shareProjects(store);
    for (let pass = 0; pass < 10; pass += 1) {
      const maintained = await maintainSearchIndex(store);
      if (maintained.complete) break;
    }
    // The store the barrier hands a search while the move is pending
    // (`storeWithMoves`): an old name reads as gone through `get`.
    return { bucket: store, store: withPendingMoves(store, [{ from: "1-projects", to }]) as unknown as FileStore };
  }

  test("a hit is shown at the folder's new name", async () => {
    const { store, bucket: raw } = await movingProjects("2-areas/moved");
    const found = await searchNotes(store, { query: "quokkaplan", clearance: clearanceOf("private") });
    // Found without moving it: a search is not an open.
    expect(Object.keys((raw as MemoryStore).snapshot())).toContain("1-projects/shared-plan.md");
    const paths = found.hits.map((hit) => hit.path);
    expect(paths).toContain("2-areas/moved/shared-plan.md");
    expect(paths.some((path) => path.startsWith("1-projects/"))).toBe(false);
  });

  test("a team member does not find a note moving somewhere private", async () => {
    const { store } = await movingProjects("2-areas/moved");
    const asTeam = await searchNotes(store, { query: "quokkaplan", clearance: clearanceOf("team") });
    expect(asTeam.hits.map((hit) => hit.path)).not.toContain("1-projects/shared-plan.md");
    expect(asTeam.hits.map((hit) => hit.path)).not.toContain("2-areas/moved/shared-plan.md");
  });
});
