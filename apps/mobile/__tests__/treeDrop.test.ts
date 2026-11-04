/**
 * Dragging a row in the sidebar tree to put it in order, or to nest it
 * (`features/console/files/treeDrop.ts`; owner, 2026-10-18: "fixed jobs, free
 * names", `docs/decisions/app-and-console/folder-jobs.md`; notes too since
 * 2026-11-04, `folder-sort.md`).
 *
 * Three zones per folder row: the top quarter drops *above* it, the bottom
 * quarter *below* it, the middle *into* it; a note row's top half drops above
 * it and its bottom half below. Between two siblings is a reorder of that
 * level, every row of it sent (`folderOrder.set`); between rows of another
 * level is a move into that level at that place, then the order; the middle
 * of a folder is the nest that was always there.
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
  return planTreeDrop({ listings, workspaceSort: null, ...over });
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

  test("a note row has no inside: its top half is above it, its bottom half below", () => {
    const note = { kind: "file" as const, expanded: false };
    expect(dropZoneAt(0.4, note, true)).toBe("above");
    expect(dropZoneAt(0.6, note, true)).toBe("below");
  });

  test("a drag that cannot be ordered (several rows, a copy) only ever nests", () => {
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
      folders: ["Capture", "Recipes", "Projects", "Areas", "website", "todo.md"],
    });
  });

  test("below the last folder is the end", () => {
    expect(plan({ paths: ["Capture"], target: "Recipes", zone: "below" })).toEqual({
      kind: "reorder",
      parent: "",
      folders: ["Projects", "Areas", "website", "Recipes", "Capture", "todo.md"],
    });
  });

  test("above the first folder is the start, built-in folders included", () => {
    expect(plan({ paths: ["Areas"], target: "Capture", zone: "above" })).toEqual({
      kind: "reorder",
      parent: "",
      folders: ["Areas", "Capture", "Projects", "website", "Recipes", "todo.md"],
    });
  });

  test("one level down works the same", () => {
    expect(plan({ paths: ["Projects/beta"], target: "Projects/alpha", zone: "above" })).toEqual({
      kind: "reorder",
      parent: "Projects",
      folders: ["Projects/beta", "Projects/alpha", "Projects/plan.md"],
    });
  });

  test("a drop that changes nothing does nothing: onto its own edge, or just below the one above it", () => {
    expect(plan({ paths: ["Projects"], target: "Projects", zone: "above" })).toEqual({ kind: "none" });
    expect(plan({ paths: ["Projects"], target: "Projects", zone: "below" })).toEqual({ kind: "none" });
    expect(plan({ paths: ["Projects"], target: "Capture", zone: "below" })).toEqual({ kind: "none" });
    expect(plan({ paths: ["Projects"], target: "Areas", zone: "above" })).toEqual({ kind: "none" });
  });

  test("sorted Z to A: above is above as drawn, and the whole level is sent as drawn", () => {
    // Drawn: website, Recipes, Projects, Capture, Areas, then todo.md. Capture above Projects.
    expect(plan({ paths: ["Capture"], target: "Projects", zone: "above", workspaceSort: "name-desc" })).toEqual({
      kind: "reorder",
      parent: "",
      folders: ["website", "Recipes", "Capture", "Projects", "Areas", "todo.md"],
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
      folders: ["Projects/alpha", "Projects/Recipes", "Projects/beta", "Projects/plan.md"],
    });
  });

  test("a built-in folder can be placed into another level; the server decides whether this workspace allows it", () => {
    expect(plan({ paths: ["Capture"], target: "Projects/alpha", zone: "below" })).toEqual({
      kind: "place",
      from: "Capture",
      parent: "Projects",
      folders: ["Projects/alpha", "Projects/Capture", "Projects/beta", "Projects/plan.md"],
    });
  });

  test("Website is placed into another level like any folder: its site follows it (owner, 2026-10-21)", () => {
    expect(plan({ paths: ["website"], target: "Projects/alpha", zone: "above" })).toEqual({
      kind: "place",
      from: "website",
      parent: "Projects",
      folders: ["Projects/website", "Projects/alpha", "Projects/beta", "Projects/plan.md"],
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
      folders: ["Capture", "Projects", "Areas", "beta", "website", "Recipes", "todo.md"],
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

  test("multi-row drags nest whatever zone they arrive with", () => {
    expect(plan({ paths: ["Recipes", "Areas"], target: "Projects", zone: "below" })).toEqual({ kind: "nest", folder: "Projects" });
  });

  test("a note dropped into a folder nests, and dropped onto a note does nothing", () => {
    expect(plan({ paths: ["todo.md"], target: "Projects", zone: "into" })).toEqual({ kind: "nest", folder: "Projects" });
    expect(plan({ paths: ["Recipes"], target: "todo.md", zone: "into" })).toEqual({ kind: "none" });
  });
});

describe("notes are put in order too (owner, 2026-11-04)", () => {
  test("a note dropped between two folders sits between them", () => {
    expect(plan({ paths: ["todo.md"], target: "Projects", zone: "above" })).toEqual({
      kind: "reorder",
      parent: "",
      folders: ["Capture", "todo.md", "Projects", "Areas", "website", "Recipes"],
    });
  });

  test("a folder dropped below a note goes after it", () => {
    expect(plan({ paths: ["Projects/alpha"], target: "Projects/plan.md", zone: "below" })).toEqual({
      kind: "reorder",
      parent: "Projects",
      folders: ["Projects/beta", "Projects/plan.md", "Projects/alpha"],
    });
  });

  test("a note from another folder is placed beside a note there", () => {
    expect(plan({ paths: ["todo.md"], target: "Projects/plan.md", zone: "above" })).toEqual({
      kind: "place",
      from: "todo.md",
      parent: "Projects",
      folders: ["Projects/alpha", "Projects/beta", "Projects/todo.md", "Projects/plan.md"],
    });
  });

  test("in custom order the rows are drawn by their order, and the drop follows what is drawn", () => {
    const custom = {
      ...listings,
      Projects: {
        ...listings.Projects!,
        sort: "custom",
        entries: [folder("Projects/alpha", { order: 20 }), folder("Projects/beta", { order: 0 }), { ...file("Projects/plan.md"), order: 10 }],
      },
    };
    // Drawn: beta, plan.md, alpha. alpha above beta.
    expect(planTreeDrop({ listings: custom, workspaceSort: null, paths: ["Projects/alpha"], target: "Projects/beta", zone: "above" })).toEqual({
      kind: "reorder",
      parent: "Projects",
      folders: ["Projects/alpha", "Projects/beta", "Projects/plan.md"],
    });
  });
});

describe("a copy (⌥) only ever goes into a folder", () => {
  test("whatever the zone, and Website may be copied: the original stays where it is published from", () => {
    expect(plan({ paths: ["Recipes"], target: "Projects", zone: "above", copying: true })).toEqual({ kind: "nest", folder: "Projects" });
    expect(plan({ paths: ["website"], target: "Areas", zone: "into", copying: true })).toEqual({ kind: "nest", folder: "Areas" });
  });
});
