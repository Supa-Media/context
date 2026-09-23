import { describe, expect, test } from "@jest/globals";
import { NO_PICK, pick, topmost, visiblePick } from "../features/console/files/selection";
import { foldersToRefresh } from "../features/console/files/tree";

/**
 * ⌘/ctrl-click and shift-click in the file tree, as rules.
 *
 * The part of multi-select worth pinning is what a modified click does to the
 * set, and the two properties that keep a bulk action from surprising
 * anybody: it acts only on rows on screen, and never twice on one path.
 */

/** The tree as drawn, top to bottom. `1-projects` is open; `2-areas` is not. */
const ORDER = [
  "1-projects",
  "1-projects/a.md",
  "1-projects/b.md",
  "1-projects/c.md",
  "2-areas",
  "index.md",
];

const set = (...paths: string[]) => new Set(paths);

describe("⌘-click toggles one row", () => {
  test("it starts from the row already highlighted, the open note", () => {
    // What Finder and VS Code do, and what the highlight on screen promised.
    const next = pick(NO_PICK, "toggle", "1-projects/c.md", ORDER, "1-projects/a.md");
    expect(next.paths).toEqual(set("1-projects/a.md", "1-projects/c.md"));
  });

  test("with nothing open, it starts from nothing", () => {
    expect(pick(NO_PICK, "toggle", "index.md", ORDER, null).paths).toEqual(set("index.md"));
  });

  test("an open note that is not on screen is not quietly added", () => {
    // Open inside `2-areas`, which is collapsed: nobody can see it highlighted.
    const next = pick(NO_PICK, "toggle", "index.md", ORDER, "2-areas/x.md");
    expect(next.paths).toEqual(set("index.md"));
  });

  test("a second ⌘-click on a picked row takes it out again", () => {
    const one = pick(NO_PICK, "toggle", "1-projects/b.md", ORDER, "1-projects/a.md");
    const two = pick(one, "toggle", "1-projects/b.md", ORDER, "1-projects/a.md");
    expect(two.paths).toEqual(set("1-projects/a.md"));
  });

  test("it moves the anchor, so a shift-click after it measures from there", () => {
    const toggled = pick(NO_PICK, "toggle", "1-projects/c.md", ORDER, "1-projects/a.md");
    expect(toggled.anchor).toBe("1-projects/c.md");
    const ranged = pick(toggled, "range", "index.md", ORDER, "1-projects/a.md");
    expect(ranged.paths).toEqual(set("1-projects/c.md", "2-areas", "index.md"));
  });
});

describe("shift-click picks everything between", () => {
  test("from the open note when nothing was clicked", () => {
    const next = pick(NO_PICK, "range", "1-projects/c.md", ORDER, "1-projects/a.md");
    expect(next.paths).toEqual(set("1-projects/a.md", "1-projects/b.md", "1-projects/c.md"));
  });

  test("upward as well as downward", () => {
    const next = pick(NO_PICK, "range", "1-projects", ORDER, "1-projects/b.md");
    expect(next.paths).toEqual(set("1-projects", "1-projects/a.md", "1-projects/b.md"));
  });

  test("a second shift-click re-measures from the same anchor, replacing the range", () => {
    const first = pick(NO_PICK, "range", "index.md", ORDER, "1-projects/b.md");
    const second = pick(first, "range", "1-projects/c.md", ORDER, "1-projects/b.md");
    expect(second.paths).toEqual(set("1-projects/b.md", "1-projects/c.md"));
  });

  test("with no anchor on screen, it is a click on one row", () => {
    expect(pick(NO_PICK, "range", "index.md", ORDER, null).paths).toEqual(set("index.md"));
    expect(pick(NO_PICK, "range", "index.md", ORDER, "2-areas/hidden.md").paths).toEqual(
      set("index.md"),
    );
  });
});

describe("only rows on screen stay picked", () => {
  test("collapsing a folder drops what was picked inside it", () => {
    const picked = { paths: set("1-projects/a.md", "index.md"), anchor: "index.md" };
    const collapsed = ORDER.filter((path) => !path.startsWith("1-projects/"));
    expect(visiblePick(picked, collapsed).paths).toEqual(set("index.md"));
  });

  test("an unchanged pick is the same object, so the tree's effect cannot loop", () => {
    const picked = { paths: set("index.md"), anchor: null };
    expect(visiblePick(picked, ORDER)).toBe(picked);
    expect(visiblePick(NO_PICK, [])).toBe(NO_PICK);
  });
});

describe("a batch acts on each path once", () => {
  test("a note inside a picked folder travels with the folder, not beside it", () => {
    expect(topmost(set("1-projects/a.md", "1-projects", "index.md"), ORDER)).toEqual([
      "1-projects",
      "index.md",
    ]);
  });

  test("deeper nesting is caught too, and siblings with a shared prefix are not", () => {
    expect(topmost(set("a", "a/b/c.md", "ab/d.md"), [])).toEqual(["a", "ab/d.md"]);
  });

  test("the result is in tree order, whatever order the clicks came in", () => {
    expect(topmost(set("index.md", "1-projects/c.md", "1-projects/a.md"), ORDER)).toEqual([
      "1-projects/a.md",
      "1-projects/c.md",
      "index.md",
    ]);
  });
});

describe("a batch that moved several folders reloads under every one of them", () => {
  test("each root's loaded subtree is stale, as a single folder move's is", () => {
    const loaded = ["", "a", "a/x", "b", "b/y", "c"];
    expect(foldersToRefresh(["a", "dest/a"], { cascadeFrom: ["a", "b"], loaded })).toEqual([
      "",
      "a",
      "a/x",
      "b",
      "b/y",
      "dest",
    ]);
  });
});
