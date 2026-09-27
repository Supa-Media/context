/**
 * The phone's Browse key: the folder page of what is open.
 *
 * Owner-approved on 2026-09-27 (the phone artboards, screens 1 and 2): Browse
 * replaced `›` on the five-key capsule, and it opens the folder page the
 * breadcrumb's segments already open. The rule is a pure function so the one
 * decision in it — a note goes to its folder, a folder goes one up — is pinned
 * without a renderer. That the key is on the row is `bottomRowWidth.test.ts`.
 *
 * SABOTAGE: `browseDestination` returning `targetFolder(...)` unchanged. The
 * folder cases fail — a folder page's Browse would re-select itself and the
 * key would look dead.
 */

import { describe, expect, test } from "@jest/globals";
import { browseDestination } from "../features/console/ConsoleBottomBar";
import type { FolderListing } from "../features/console/files/types";

function listing(path: string, entries: FolderListing["entries"]): FolderListing {
  return {
    path,
    folderDefault: "private",
    truncated: false,
    manifestUsable: true,
    entries,
  } as FolderListing;
}

const listings: Record<string, FolderListing> = {
  "": listing("", [
    {
      kind: "folder",
      path: "1-projects",
      name: "1-projects",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
    {
      kind: "file",
      path: "todo.md",
      name: "todo.md",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
  ] as FolderListing["entries"]),
  "1-projects": listing("1-projects", [
    {
      kind: "folder",
      path: "1-projects/trips",
      name: "trips",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
  ] as FolderListing["entries"]),
};

describe("the Browse key", () => {
  test("from a note, opens the folder the note is in", () => {
    expect(browseDestination(listings, "1-projects/trips/plan.md")).toBe("1-projects/trips");
  });

  test("from a top-level note, opens the context's own page", () => {
    expect(browseDestination(listings, "todo.md")).toBe("");
  });

  test("from a folder page, goes one folder up", () => {
    expect(browseDestination(listings, "1-projects/trips")).toBe("1-projects");
    expect(browseDestination(listings, "1-projects")).toBe("");
  });

  test("from a folder whose parent has not been listed, still goes one up", () => {
    // `targetFolder`'s rule: an unknown path that is not markdown is a folder.
    expect(browseDestination({}, "2-areas/health")).toBe("2-areas");
  });

  test("on the context's own page there is nowhere further out", () => {
    expect(browseDestination(listings, null)).toBeNull();
  });
});
