/**
 * Where a new note is created: `targetFolder`.
 *
 * Split out of `fileEditor.test.ts`; see `fixtures.ts` in this folder.
 */

import { describe, expect, test } from "@jest/globals";
import { targetFolder } from "../../features/console/files/tree";
import type { FolderListing } from "../../features/console/files/types";
import { fileEntry, folderEntry } from "./fixtures";

describe("targetFolder", () => {
  /**
   * This exists because the rule was written twice and the copies disagreed.
   * The explorer's toolbar had it right; the phone's bottom toolbar used
   * `parentPath(selectedPath)` unconditionally — and since selecting a folder
   * in the tree also expands it, `selectedPath` is *routinely* a folder. So
   * tapping `1-projects` on a phone and then `+` created the note at the root.
   */
  const listings: Record<string, FolderListing> = {
    "": {
      path: "",
      folderDefault: "private",
      truncated: false,
      manifestUsable: true,
      entries: [
        folderEntry("1-projects"),
        fileEntry("index.md"),
      ],
    },
    "1-projects": {
      path: "1-projects",
      folderDefault: "team",
      truncated: false,
      manifestUsable: true,
      entries: [fileEntry("1-projects/plan.md")],
    },
  };

  test("a selected folder is the destination", () => {
    expect(targetFolder(listings, "1-projects")).toBe("1-projects");
  });

  test("a selected note means the folder it sits in", () => {
    expect(targetFolder(listings, "1-projects/plan.md")).toBe("1-projects");
    expect(targetFolder(listings, "index.md")).toBe("");
  });

  test("nothing selected is the root, which is a real destination", () => {
    expect(targetFolder(listings, null)).toBe("");
  });

  test("an unloaded note falls back to its parent", () => {
    // Not in any listing, so `findEntry` cannot say what it is — but a note is
    // `.md` by construction (`createNote` appends it, `writeNote` refuses
    // anything else), so the extension answers.
    expect(targetFolder(listings, "2-areas/health.md")).toBe("2-areas");
  });

  test("an unloaded FOLDER is the destination, not its parent", () => {
    /*
      The case a deep link produces, and the one this used to get wrong.
      `findEntry` looks a path up in its *parent's* listing, so a folder whose
      parent has not been fetched answers `null` — and the old rule read that
      `null` as "not a folder" and went up a level. The pane meanwhile drew the
      folder, because `useFileBrowser.select` had already been given the
      extension rule. So the screen said `2-areas/health` and `+` wrote into
      `2-areas`.
    */
    expect(targetFolder(listings, "2-areas/health")).toBe("2-areas/health");
    expect(targetFolder(listings, "2-areas")).toBe("2-areas");
  });
});
