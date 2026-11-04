/**
 * One folder's rows as drawn, and the order Move up, Move down and a drop put
 * them in (`features/console/files/levelOrder.ts`; owner, 2026-11-04,
 * `docs/decisions/app-and-console/folder-sort.md`).
 *
 * SABOTAGE: make `moversOf` return every row whatever the sort and "outside
 * custom order Move up moves a folder among the folders" fails; drop the
 * `sort: "custom"` from `withRowOrder` and "a reorder draws the folder in
 * custom order at once" fails; let `withFolderSort` pass custom down and "custom
 * order is never passed down" fails.
 *
 * Fixture names are obviously fake; this repository is public.
 */

import { describe, expect, test } from "@jest/globals";
import {
  drawnLevel,
  droppedLevel,
  movedLevel,
  rowPlace,
  withFolderSort,
  withRowOrder,
} from "../features/console/files/levelOrder";
import type { FileEntry, FolderListing } from "../features/console/files/types";

function entry(kind: "file" | "folder", path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    kind,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...over,
  };
}
const folder = (path: string, over: Partial<FileEntry> = {}) => entry("folder", path, over);
const file = (path: string, over: Partial<FileEntry> = {}) => entry("file", path, over);

function listing(path: string, entries: FileEntry[], sort?: string): FolderListing {
  return { path, folderDefault: "private", entries, ...(sort === undefined ? {} : { sort }) } as FolderListing;
}

const NAMED = {
  "": listing("", [folder("Projects")]),
  // In the server's order, as a listing with no setting arrives.
  Projects: listing("Projects", [folder("Projects/alpha"), folder("Projects/zeta"), file("Projects/a.md"), file("Projects/b.md")]),
};

const CUSTOM = {
  "": listing("", [folder("Projects", { sort: "custom" })]),
  Projects: listing(
    "Projects",
    [
      file("Projects/b.md", { order: 0 }),
      folder("Projects/zeta", { order: 10 }),
      file("Projects/a.md", { order: 20 }),
      folder("Projects/alpha", { order: 30 }),
    ],
    "custom",
  ),
};

describe("a level as drawn", () => {
  test("by name, folders above notes", () => {
    expect(drawnLevel(NAMED, "Projects", null)?.paths).toEqual(["Projects/alpha", "Projects/zeta", "Projects/a.md", "Projects/b.md"]);
  });

  test("in custom order, notes and folders mixed by their place", () => {
    expect(drawnLevel(CUSTOM, "Projects", null)?.paths).toEqual(["Projects/b.md", "Projects/zeta", "Projects/a.md", "Projects/alpha"]);
  });

  test("not loaded yet: nothing", () => {
    expect(drawnLevel(NAMED, "Elsewhere", null)).toBeNull();
  });
});

describe("Move up and Move down", () => {
  test("outside custom order Move up moves a folder among the folders, and the notes keep their drawn places", () => {
    const level = drawnLevel(NAMED, "Projects", null)!;
    expect(movedLevel(level, "Projects/zeta", "up")).toEqual(["Projects/zeta", "Projects/alpha", "Projects/a.md", "Projects/b.md"]);
    expect(rowPlace(NAMED, "Projects/a.md", null)).toBeNull();
    expect(rowPlace(NAMED, "Projects/alpha", null)).toEqual({ first: true, last: false });
  });

  test("in custom order a note moves past a folder", () => {
    const level = drawnLevel(CUSTOM, "Projects", null)!;
    expect(movedLevel(level, "Projects/a.md", "up")).toEqual(["Projects/b.md", "Projects/a.md", "Projects/zeta", "Projects/alpha"]);
    expect(rowPlace(CUSTOM, "Projects/b.md", null)).toEqual({ first: true, last: false });
    expect(movedLevel(level, "Projects/b.md", "up")).toBeNull();
  });
});

describe("a drop between two rows", () => {
  test("puts the row just above or below the target, every row of the level sent", () => {
    const level = drawnLevel(CUSTOM, "Projects", null)!;
    expect(droppedLevel(level, "Projects/alpha", "Projects/b.md", "above")).toEqual([
      "Projects/alpha",
      "Projects/b.md",
      "Projects/zeta",
      "Projects/a.md",
    ]);
    expect(droppedLevel(level, "Projects/b.md", "Projects/zeta", "above")).toBeNull();
    expect(droppedLevel(level, "Projects/b.md", "Projects/b.md", "below")).toBeNull();
  });
});

describe("drawing the change before the server confirms it", () => {
  test("a reorder draws the folder in custom order at once", () => {
    const next = withRowOrder("Projects", NAMED.Projects, ["Projects/b.md", "Projects/alpha", "Projects/zeta", "Projects/a.md"]);
    expect(next.sort).toBe("custom");
    expect(drawnLevel({ ...NAMED, Projects: next }, "Projects", null)?.paths).toEqual([
      "Projects/b.md",
      "Projects/alpha",
      "Projects/zeta",
      "Projects/a.md",
    ]);
  });

  test("the top level keeps the workspace's setting, which a listing never carries", () => {
    expect(withRowOrder("", NAMED[""], ["Projects"]).sort).toBeUndefined();
  });

  test("a folder's setting reaches its own listing, its entry and the folders beneath with none", () => {
    const loaded = { ...NAMED, "Projects/alpha": listing("Projects/alpha", [file("Projects/alpha/x.md")]) };
    const next = withFolderSort(loaded, "Projects", "edited-desc", false);
    expect(next.Projects?.sort).toBe("edited-desc");
    expect(next[""]?.entries[0]?.sort).toBe("edited-desc");
    expect(next["Projects/alpha"]?.sort).toBe("edited-desc");
  });

  test("custom order is never passed down", () => {
    const loaded = { ...NAMED, "Projects/alpha": listing("Projects/alpha", [file("Projects/alpha/x.md")]) };
    const next = withFolderSort(loaded, "Projects", "custom", false);
    expect(next.Projects?.sort).toBe("custom");
    expect(next["Projects/alpha"]?.sort).toBeUndefined();
  });

  test("a folder beneath with its own setting keeps it, unless the change is applied inside", () => {
    const loaded = {
      ...NAMED,
      Projects: listing("Projects", [folder("Projects/alpha", { sort: "name-desc" })]),
      "Projects/alpha": listing("Projects/alpha", [], "name-desc"),
    };
    expect(withFolderSort(loaded, "Projects", "edited-asc", false)["Projects/alpha"]?.sort).toBe("name-desc");
    const inside = withFolderSort(loaded, "Projects", "edited-asc", true);
    expect(inside["Projects/alpha"]?.sort).toBe("edited-asc");
    expect(inside.Projects?.entries[0]?.sort).toBeUndefined();
  });
});
