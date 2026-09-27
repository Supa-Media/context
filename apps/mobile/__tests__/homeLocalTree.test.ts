import { describe, expect, test } from "@jest/globals";
import { liveHomeTree } from "../features/home/homeSite";
import {
  addFolder,
  addNote,
  copyPath,
  editNote,
  followPath,
  freeName,
  movePath,
  notesUnder,
  removePath,
  renamePath,
} from "../features/home/localTree";

/**
 * What a visitor does to the homepage's workspace, done to the tree alone.
 * Every change is in memory; these hold that each one leaves a tree the
 * Explorer can draw: every note listed in its folder, every folder listed in
 * its parent, and nothing left behind at an old path.
 */

const { tree: site } = liveHomeTree([
  { path: "index.md", routePath: "/", title: "Welcome", markdown: "# Welcome" },
  { path: "pricing.md", routePath: "/pricing", title: "Pricing", markdown: "# Pricing" },
  { path: "Legal/privacy.md", routePath: "/Legal/privacy", title: "Privacy", markdown: "# Privacy" },
]);

/** Every path the listings name, and every note, sorted: the tree's whole shape. */
function shape(tree: typeof site) {
  const listed = Object.values(tree.listings).flatMap((listing) => listing.entries.map((entry) => entry.path));
  return { listed: listed.sort(), folders: Object.keys(tree.listings).sort(), notes: Object.keys(tree.notes).sort() };
}

describe("making things", () => {
  test("a note lands in its folder, empty, under a name nobody has", () => {
    const first = addNote(site, "03-Legal", "terms")!;
    expect(first.path).toBe("03-Legal/terms.md");
    expect(first.tree.notes[first.path]).toBe("");
    expect(first.tree.listings["03-Legal"]!.entries.map((entry) => entry.name)).toContain("terms.md");
    const second = addNote(first.tree, "03-Legal", "terms.md")!;
    expect(second.path).toBe("03-Legal/terms 2.md");
  });

  test("a folder is listed in its parent and has a listing of its own", () => {
    const made = addFolder(site, "", "Guides")!;
    expect(made.path).toBe("Guides");
    expect(made.tree.listings.Guides!.entries).toEqual([]);
    expect(made.tree.listings[""]!.entries.find((entry) => entry.path === "Guides")?.kind).toBe("folder");
  });

  test("a slash is not a folder, a blank is not a name, and a missing folder is refused", () => {
    expect(addNote(site, "", "a/b")!.path).toBe("a-b.md");
    expect(addNote(site, "", "   ")).toBeNull();
    expect(addFolder(site, "nowhere", "x")).toBeNull();
    expect(freeName(site, "", "01-welcome.md")).toBe("01-welcome 2.md");
  });
});

describe("changing things", () => {
  test("editing changes one note's words and nothing else", () => {
    const edited = editNote(site, "02-Pricing.md", "# Cheaper");
    expect(edited.notes["02-Pricing.md"]).toBe("# Cheaper");
    expect(edited.listings).toBe(site.listings);
    expect(editNote(site, "03-Legal", "x")).toBe(site);
  });

  test("renaming a folder takes everything in it along", () => {
    const renamed = renamePath(site, "03-Legal", "Policies")!;
    expect(renamed.path).toBe("Policies");
    expect(shape(renamed.tree)).toEqual({
      listed: ["01-Welcome.md", "02-Pricing.md", "Policies", "Policies/01-Privacy.md"],
      folders: ["", "Policies"],
      notes: ["01-Welcome.md", "02-Pricing.md", "Policies/01-Privacy.md"],
    });
  });

  test("a renamed note keeps its .md", () => {
    expect(renamePath(site, "02-Pricing.md", "Plans")!.path).toBe("Plans.md");
  });

  test("moving puts the entry in its new folder and takes it out of the old", () => {
    const moved = movePath(site, "02-Pricing.md", "03-Legal")!;
    expect(moved.path).toBe("03-Legal/02-Pricing.md");
    expect(moved.tree.listings[""]!.entries.map((entry) => entry.path)).toEqual(["01-Welcome.md", "03-Legal"]);
    expect(moved.tree.listings["03-Legal"]!.entries.map((entry) => entry.path)).toEqual([
      "03-Legal/01-Privacy.md",
      "03-Legal/02-Pricing.md",
    ]);
    expect(moved.tree.notes["03-Legal/02-Pricing.md"]).toBe("# Pricing");
  });

  test("a folder cannot move into itself", () => {
    const nested = addFolder(site, "03-Legal", "Old")!.tree;
    expect(movePath(nested, "03-Legal", "03-Legal/Old")).toBeNull();
  });

  test("copying a folder copies what is in it and leaves the original", () => {
    const copied = copyPath(site, "03-Legal", "")!;
    expect(copied.path).toBe("03-Legal 2");
    expect(copied.tree.notes["03-Legal 2/01-Privacy.md"]).toBe("# Privacy");
    expect(copied.tree.notes["03-Legal/01-Privacy.md"]).toBe("# Privacy");
    expect(copied.tree.listings["03-Legal 2"]!.entries.map((entry) => entry.path)).toEqual([
      "03-Legal 2/01-Privacy.md",
    ]);
  });

  test("deleting a folder deletes everything in it", () => {
    expect(shape(removePath(site, "03-Legal"))).toEqual({
      listed: ["01-Welcome.md", "02-Pricing.md"],
      folders: [""],
      notes: ["01-Welcome.md", "02-Pricing.md"],
    });
    expect(removePath(site, "")).toBe(site);
  });
});

describe("following a path through a change", () => {
  test("what was under the old path is under the new one, and the rest stays put", () => {
    expect(followPath("03-Legal/01-Privacy.md", "03-Legal", "Policies")).toBe("Policies/01-Privacy.md");
    expect(followPath("03-Legal", "03-Legal", "Policies")).toBe("Policies");
    expect(followPath("03-Legal 2/x.md", "03-Legal", "Policies")).toBe("03-Legal 2/x.md");
    expect(followPath("03-Legal/01-Privacy.md", "03-Legal", null)).toBeNull();
  });

  test("a folder's notes are what a tab strip hears about", () => {
    expect(notesUnder(site, "03-Legal")).toEqual(["03-Legal/01-Privacy.md"]);
    expect(notesUnder(site, "02-Pricing.md")).toEqual(["02-Pricing.md"]);
  });
});
