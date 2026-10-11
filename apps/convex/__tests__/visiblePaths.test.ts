/**
 * `visiblePathsOf` — which of the paths the control plane holds about a
 * workspace (a move's two ends) this caller may see now. A note by `canSee`,
 * a folder by the file tree's own folder rule, plumbing never.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, setFolderVisibility, setVisibility } from "../functions/lib/fileOps";
import { visiblePathsOf } from "../functions/lib/fileOps/visiblePaths";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

async function bucket(): Promise<MemoryStore & FileStore> {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("1-projects/plan.md", "# Plan\n");
  store.seed("1-projects/pay.md", "# Pay\n");
  const owner = clearanceOf("private");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: owner });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: owner });
  return store;
}

describe("visiblePathsOf", () => {
  test("a team caller keeps shared notes and folders, and loses private ones and plumbing", async () => {
    const store = await bucket();
    const asked = [
      "1-projects/plan.md",
      "1-projects/gone-now.md",
      "1-projects/pay.md",
      "1-projects/research",
      "2-areas/salary.md",
      "2-areas",
      ".context/forwarding.json",
      "",
    ];
    expect(await visiblePathsOf(store, clearanceOf("team"), asked)).toEqual([
      "1-projects/plan.md",
      // A note that no longer exists is still a location with a visibility,
      // which is the question for a move that already happened.
      "1-projects/gone-now.md",
      "1-projects/research",
    ]);
  });

  test("the owner keeps every note and folder, and still never plumbing", async () => {
    const store = await bucket();
    expect(
      await visiblePathsOf(store, clearanceOf("private"), ["2-areas/salary.md", "2-areas", ".context/x.md"]),
    ).toEqual(["2-areas/salary.md", "2-areas"]);
  });
});
