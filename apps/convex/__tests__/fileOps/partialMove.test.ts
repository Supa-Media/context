/**
 * A FOLDER MOVE THAT MEETS A NAME THE TREE HAD NOT HEARD OF STOPS PART WAY,
 * AND WHAT ALREADY MOVED KEEPS ITS VISIBILITY.
 *
 * `movePath` asks the tree which destinations are taken (`treeChecks.ts`) and
 * then writes each one `onlyIf: { absent: true }`. The tree can be seconds
 * behind a write made past the console, so the conditional write is what
 * finds that name, mid-folder. Stopping there leaves some notes moved; they
 * must not be left on the destination folder's rule (a private note landing
 * in a team folder would be published by the stop), and nothing of the
 * stranger's is overwritten.
 *
 * Sabotage (temporary local edits, reverted):
 *  - dropping the `remapPrivacy` before the throw: the moved note reads as
 *    `team` in its new folder;
 *  - the copy without `onlyIf: { absent: true }`: the stranger's note is
 *    overwritten.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { type FileStore, movePath } from "../../functions/lib/fileOps";
import type { TreeNames } from "../../functions/lib/fileOps/treeChecks";
import { PRIVACY_KEY, effectiveVisibility, parsePrivacyManifest } from "../../functions/lib/privacy";
import { NOW, bucket, capture, shareProjects } from "./fixtures.helpers";

/** The tree's view: the bucket without `unheard`, and every asked name free unless it holds it. */
function treeMissing(store: FileStore & { snapshot(): Record<string, string> }, unheard: string) {
  const listing: TreeNames = {
    list: async (options) => {
      const page = await store.list(options);
      return { ...page, objects: (page.objects ?? []).filter((object) => object.key !== unheard) };
    },
    taken: async (paths) => ({
      files: paths.filter((path) => path !== unheard && store.snapshot()[path] !== undefined),
      folders: [],
    }),
  };
  Object.defineProperty(store, "treeListing", { value: listing, enumerable: false, configurable: true });
}

describe("a folder move that meets a name the tree had not heard of", () => {
  test("stops part way, overwrites nothing, and what moved keeps its visibility", async () => {
    const store = bucket({ conditional: true });
    await shareProjects(store);
    // Drawings, so `movePath` copies them itself rather than through the document move.
    store.seed("2-areas/plans/a.excalidraw.md", "# A\n");
    store.seed("2-areas/plans/b.excalidraw.md", "# B\n");
    store.seed("1-projects/plans/b.excalidraw.md", "# Somebody's, a second old\n");
    treeMissing(store, "1-projects/plans/b.excalidraw.md");

    const error = await capture(() =>
      movePath(store, { from: "2-areas/plans", to: "1-projects/plans", clearance: clearanceOf("private"), now: NOW }),
    );
    expect(error.code).toBe("DESTINATION_EXISTS");
    expect(error.message).toMatch(/stopped part way/);

    const after = store.snapshot();
    expect(after["1-projects/plans/b.excalidraw.md"]).toBe("# Somebody's, a second old\n");
    expect(after["2-areas/plans/b.excalidraw.md"]).toBe("# B\n");
    expect(after["1-projects/plans/a.excalidraw.md"]).toBe("# A\n");
    expect(after["2-areas/plans/a.excalidraw.md"]).toBeUndefined();

    const manifest = parsePrivacyManifest(after[PRIVACY_KEY]!);
    expect(effectiveVisibility("1-projects/plans/a.excalidraw.md", manifest.rules, manifest.overrides)).toBe("private");
  });
});
