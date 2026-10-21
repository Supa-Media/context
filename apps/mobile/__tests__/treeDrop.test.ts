/**
 * Dragging a folder in the sidebar tree to put it in order, or to nest it
 * (`features/console/files/treeDrop.ts`; owner, 2026-10-18: "fixed jobs, free
 * names", `docs/decisions/app-and-console/folder-jobs.md`).
 *
 * Three zones per folder row: the top quarter drops *above* it, the bottom
 * quarter *below* it, the middle *into* it. Between two siblings is a reorder
 * of that level (`folderOrder.set`); between rows of another level is a move
 * into that level at that place, then the order; the middle is the nest that
 * was always there.
 *
 * SABOTAGE: drop the `fixed` check from the cross-level branch of
 * `planTreeDrop` and "Website keeps its place: it cannot be dropped into
 * another level" fails; drop the inside-itself check and "a folder cannot be
 * dropped between its own children" fails.
 *
 * Fixture names are obviously fake; this repository is public.
 */

import { describe, expect, test } from "@jest/globals";
import { dropZoneAt, planTreeDrop, type TreeDropInput } from "../features/console/files/treeDrop";
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
const file = (path: string) => entry("file", path);

function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "private", entries, truncated: false, manifestUsable: true };
}

const listings: Readonly<Record<string, FolderListing | undefined>> = {
  "": listing("", [
    folder("Capture", { role: "inbox" }),
    folder("Projects", { role: "projects" }),
    folder("Areas", { role: "areas" }),
    folder("website", { role: "website" }),
    folder("Recipes"),
    file("todo.md"),
  ]),
  Projects: listing("Projects", [folder("Projects/alpha"), folder("Projects/beta"), file("Projects/plan.md")]),
  "Projects/alpha": listing("Projects/alpha", [folder("Projects/alpha/inner")]),
  Areas: listing("Areas", [folder("Areas/Recipes")]),
};

function plan(over: Partial<TreeDropInput> & Pick<TreeDropInput, "paths" | "target" | "zone">) {
  return planTreeDrop({ listings, descending: false, ...over });
}

describe("which zone of a row the pointer is in", () => {
  const closed = { kind: "folder" as const, expanded: false };
  const open = { kind: "folder" as const, expanded: true };

  test("top quarter above, bottom quarter below, middle into", () => {
    expect(dropZoneAt(0, closed, true)).toBe("above");
    expect(dropZoneAt(0.2, closed, true)).toBe("above");
    expect(dropZoneAt(0.25, closed, true)).toBe("into");
    expect(dropZoneAt(0.5, closed, true)).toBe("into");
    expect(dropZoneAt(0.75, closed, true)).toBe("into");
    expect(dropZoneAt(0.8, closed, true)).toBe("below");
    expect(dropZoneAt(1, closed, true)).toBe("below");
  });

  test("below an open folder is its first child's place, so it nests", () => {
    expect(dropZoneAt(0.9, open, true)).toBe("into");
    expect(dropZoneAt(0.1, open, true)).toBe("above");
  });

  test("a drag that cannot be ordered (notes, several rows) only ever nests", () => {
    expect(dropZoneAt(0.05, closed, false)).toBe("into");
    expect(dropZoneAt(0.95, closed, false)).toBe("into");
  });

  test("a pointer outside the row, or no position at all, is the middle", () => {
    expect(dropZoneAt(undefined, closed, true)).toBe("into");
    expect(dropZoneAt(Number.NaN, closed, true)).toBe("into");
    expect(dropZoneAt(-3, closed, true)).toBe("above");
    expect(dropZoneAt(7, closed, true)).toBe("below");
  });
});

describe("between two siblings: a reorder of that level", () => {
  test("dropping Recipes above Projects puts it second", () => {
    expect(plan({ paths: ["Recipes"], target: "Projects", zone: "above" })).toEqual({
      kind: "reorder",
      parent: "",
      folders: ["Capture", "Recipes", "Projects", "Areas", "website"],
    });
  });

  test("below the last folder is the end", () => {
    expect(plan({ paths: ["Capture"], target: "Recipes", zone: "below" })).toEqual({
      kind: "reorder",
      parent: "",
      folders: ["Projects", "Areas", "website", "Recipes", "Capture"],
    });
  });

  test("above the first folder is the start, built-in folders included", () => {
    expect(plan({ paths: ["Areas"], target: "Capture", zone: "above" })).toEqual({
      kind: "reorder",
      parent: "",
      folders: ["Areas", "Capture", "Projects", "website", "Recipes"],
    });
  });

  test("one level down works the same", () => {
    expect(plan({ paths: ["Projects/beta"], target: "Projects/alpha", zone: "above" })).toEqual({
      kind: "reorder",
      parent: "Projects",
      folders: ["Projects/beta", "Projects/alpha"],
    });
  });

  test("a drop that changes nothing does nothing: onto its own edge, or just below the one above it", () => {
    expect(plan({ paths: ["Projects"], target: "Projects", zone: "above" })).toEqual({ kind: "none" });
    expect(plan({ paths: ["Projects"], target: "Projects", zone: "below" })).toEqual({ kind: "none" });
    expect(plan({ paths: ["Projects"], target: "Capture", zone: "below" })).toEqual({ kind: "none" });
    expect(plan({ paths: ["Projects"], target: "Areas", zone: "above" })).toEqual({ kind: "none" });
  });

  test("Z to A: above is above as drawn, and the server is sent its own order", () => {
    // Drawn: Recipes, website, Areas, Projects, Capture. Capture above Areas.
    expect(plan({ paths: ["Capture"], target: "Areas", zone: "above", descending: true })).toEqual({
      kind: "reorder",
      parent: "",
      folders: ["Projects", "Areas", "Capture", "website", "Recipes"],
    });
  });

  test("Website may change places with its siblings: that is Move up and Move down, which it has", () => {
    expect(plan({ paths: ["website"], target: "Capture", zone: "above" })).toMatchObject({ kind: "reorder" });
  });
});

describe("between rows of another level: a move there, at that place", () => {
  test("Recipes dropped between alpha and beta lands in Projects, second", () => {
    expect(plan({ paths: ["Recipes"], target: "Projects/beta", zone: "above" })).toEqual({
      kind: "place",
      from: "Recipes",
      parent: "Projects",
      folders: ["Projects/alpha", "Projects/Recipes", "Projects/beta"],
    });
  });

  test("a built-in folder can be placed into another level; the server decides whether this workspace allows it", () => {
    expect(plan({ paths: ["Capture"], target: "Projects/alpha", zone: "below" })).toEqual({
      kind: "place",
      from: "Capture",
      parent: "Projects",
      folders: ["Projects/alpha", "Projects/Capture", "Projects/beta"],
    });
  });

  test("Website is placed into another level like any folder: its site follows it (owner, 2026-10-21)", () => {
    expect(plan({ paths: ["website"], target: "Projects/alpha", zone: "above" })).toEqual({
      kind: "place",
      from: "website",
      parent: "Projects",
      folders: ["Projects/website", "Projects/alpha", "Projects/beta"],
    });
  });

  test("and nested", () => {
    expect(plan({ paths: ["website"], target: "Areas", zone: "into" })).toEqual({ kind: "nest", folder: "Areas" });
  });

  test("a nested folder dropped between root rows comes up to the root", () => {
    expect(plan({ paths: ["Projects/beta"], target: "Areas", zone: "below" })).toEqual({
      kind: "place",
      from: "Projects/beta",
      parent: "",
      folders: ["Capture", "Projects", "Areas", "beta", "website", "Recipes"],
    });
  });
});

describe("refused drops say why", () => {
  test("a folder cannot be dropped between its own children", () => {
    expect(plan({ paths: ["Projects"], target: "Projects/alpha", zone: "above" })).toEqual({
      kind: "refuse",
      reason: "A folder cannot be moved inside itself.",
    });
    expect(plan({ paths: ["Projects"], target: "Projects/alpha/inner", zone: "below" })).toMatchObject({ kind: "refuse" });
  });

  test("a folder cannot be nested into itself or below itself", () => {
    expect(plan({ paths: ["Projects"], target: "Projects", zone: "into" })).toMatchObject({ kind: "refuse" });
    expect(plan({ paths: ["Projects"], target: "Projects/alpha", zone: "into" })).toEqual({
      kind: "refuse",
      reason: "A folder cannot be moved inside itself.",
    });
  });

  test("a name already taken in the other level refuses the move rather than renaming it", () => {
    expect(plan({ paths: ["Recipes"], target: "Areas/Recipes", zone: "above" })).toEqual({
      kind: "refuse",
      reason: "Areas already has something called Recipes.",
    });
  });
});

describe("nesting is unchanged", () => {
  test("the middle of a folder row is a drop into it", () => {
    expect(plan({ paths: ["Recipes"], target: "Projects", zone: "into" })).toEqual({ kind: "nest", folder: "Projects" });
  });

  test("notes and multi-row drags nest whatever zone they arrive with", () => {
    expect(plan({ paths: ["todo.md"], target: "Projects", zone: "above" })).toEqual({ kind: "nest", folder: "Projects" });
    expect(plan({ paths: ["Recipes", "Areas"], target: "Projects", zone: "below" })).toEqual({ kind: "nest", folder: "Projects" });
  });
});

describe("a copy (⌥) only ever goes into a folder", () => {
  test("whatever the zone, and Website may be copied: the original stays where it is published from", () => {
    expect(plan({ paths: ["Recipes"], target: "Projects", zone: "above", copying: true })).toEqual({ kind: "nest", folder: "Projects" });
    expect(plan({ paths: ["website"], target: "Areas", zone: "into", copying: true })).toEqual({ kind: "nest", folder: "Areas" });
  });
});
