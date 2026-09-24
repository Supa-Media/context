/**
 * The marker rule ("mark only what differs from the folder default"),
 * building tree rows from listings, and which folders a change refreshes.
 *
 * Split out of `fileEditor.test.ts`; see `fixtures.ts` in this folder.
 */

import { describe, expect, test } from "@jest/globals";
import { buildTreeRows, findEntry, foldersToRefresh, markerFor, namesIn } from "../../features/console/files/tree";
import { file, folder, listing } from "./fixtures";

describe("a row is marked only when it differs from the folder it is in", () => {
  test("a file that inherits its folder's default gets no marker", () => {
    expect(markerFor(file("2-areas/a.md"))).toBeUndefined();
    expect(
      markerFor(file("1-projects/a.md", { visibility: "team", inherited: "team" })),
    ).toBeUndefined();
  });

  test("a private note in a shared folder is marked private", () => {
    expect(
      markerFor(file("1-projects/pay.md", { visibility: "private", inherited: "team", exception: true })),
    ).toBe("private");
  });

  test("a shared note in a private folder is marked team", () => {
    expect(
      markerFor(file("2-areas/handbook.md", { visibility: "team", inherited: "private", exception: true })),
    ).toBe("team");
  });

  /**
   * A folder is held to the same rule as a file, against its *parent's*
   * default.
   *
   * This is the half that changed. A folder used to print its own default
   * unconditionally, which on a bucket laid out the standard way put a label
   * beside every one of the PARA roots — five labels stating the two facts the
   * root already states. What is left is the folder somebody deliberately made
   * different, which is the only one worth a glance.
   *
   * `parentDefault` is the *listing's* default, not the folder's own. Passing
   * the folder's own would make every folder match itself and mark nothing,
   * which is the mistake this pair of cases exists to catch.
   */
  test("a folder is marked only when its default differs from its parent's", () => {
    expect(markerFor(folder("2-areas", "private"), "private")).toBeUndefined();
    expect(markerFor(folder("1-projects", "team"), "team")).toBeUndefined();
    expect(markerFor(folder("1-projects", "team"), "private")).toBe("team");
    expect(markerFor(folder("2-areas", "private"), "team")).toBe("private");
  });

  /**
   * With no parent default in hand, a folder keeps the old, safe answer.
   *
   * The argument is optional so a caller holding only an entry — there is one
   * in the landing page's demo data — gets a label rather than a silent
   * `undefined`. Over-labelling is a worse screen; under-labelling is a wrong
   * one.
   */
  test("a folder with no parent default given still states its own", () => {
    expect(markerFor(folder("2-areas", "private"))).toBe("private");
    expect(markerFor(folder("1-projects", "team"))).toBe("team");
  });

  /**
   * Stated as the property rather than as cases: in a folder where nothing is
   * unusual, the tree draws no file markers at all. That is the noise the rule
   * exists to remove.
   */
  test("a folder full of ordinary notes produces no file markers", () => {
    const rows = buildTreeRows({
      listings: {
        "": listing("", [folder("2-areas")]),
        "2-areas": listing("2-areas", [
          file("2-areas/a.md"),
          file("2-areas/b.md"),
          file("2-areas/c.md"),
        ]),
      },
      expanded: new Set(["2-areas"]),
      selectedPath: null,
    });
    const fileRows = rows.filter((row) => row.kind === "file");
    expect(fileRows).toHaveLength(3);
    expect(fileRows.every((row) => row.marker === undefined)).toBe(true);
    // And the folder is unmarked too: `listing("")` defaults to `private`, so
    // a private `2-areas` inside it is the ordinary case, not the notable one.
    expect(rows.find((row) => row.kind === "folder")?.marker).toBeUndefined();
  });

  /**
   * The whole tree, drawn silent.
   *
   * The property the rule is *for*, stated once at the level a person sees:
   * open a context where every folder and every note takes the default and
   * there is not one label on the screen. Before this, the same context drew
   * one on every folder row.
   */
  test("a context where nothing is unusual draws no markers at all", () => {
    const rows = buildTreeRows({
      listings: {
        "": listing("", [folder("1-projects"), folder("2-areas"), file("index.md")]),
        "1-projects": listing("1-projects", [file("1-projects/plan.md")]),
        "2-areas": listing("2-areas", [file("2-areas/a.md")]),
      },
      expanded: new Set(["1-projects", "2-areas"]),
      selectedPath: null,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.marker === undefined)).toBe(true);
  });

  /**
   * And the one exception is the only thing on it.
   *
   * The counterpart to the case above, so "draws nothing" cannot be satisfied
   * by a rule that draws nothing ever.
   */
  test("one deliberately shared folder is the only marked row", () => {
    const rows = buildTreeRows({
      listings: {
        "": listing("", [folder("1-projects", "team"), folder("2-areas")]),
        "1-projects": listing("1-projects", [file("1-projects/plan.md")]),
      },
      expanded: new Set(["1-projects"]),
      selectedPath: null,
    });
    const marked = rows.filter((row) => row.marker !== undefined);
    expect(marked.map((row) => [row.path, row.marker])).toEqual([["1-projects", "team"]]);
  });
});

describe("building tree rows", () => {
  const listings = {
    "": listing("", [folder("1-projects", "team"), file("index.md")]),
    "1-projects": listing("1-projects", [
      folder("1-projects/plans"),
      file("1-projects/a.md", { visibility: "team", inherited: "team" }),
      file("1-projects/pay.md", { visibility: "private", inherited: "team", exception: true }),
    ]),
  };

  test("a collapsed folder shows only itself", () => {
    const rows = buildTreeRows({ listings, expanded: new Set(), selectedPath: null });
    expect(rows.map((row) => row.path)).toEqual(["1-projects", "index.md"]);
  });

  test("an expanded folder shows its children one level deeper", () => {
    const rows = buildTreeRows({
      listings,
      expanded: new Set(["1-projects"]),
      selectedPath: "1-projects/pay.md",
    });
    expect(rows.map((row) => row.path)).toEqual([
      "1-projects",
      "1-projects/plans",
      "1-projects/a.md",
      "1-projects/pay.md",
      "index.md",
    ]);
    expect(rows.find((row) => row.path === "1-projects/a.md")?.depth).toBe(1);
    expect(rows.find((row) => row.path === "1-projects/pay.md")?.selected).toBe(true);
  });

  /**
   * "Not loaded" and "empty" are different sentences to put in front of
   * somebody looking at their own notes, so they are different rows.
   */
  test("an expanded folder whose listing has not arrived says so", () => {
    const rows = buildTreeRows({
      listings: { "": listings[""] },
      expanded: new Set(["1-projects"]),
      selectedPath: null,
    });
    expect(rows.map((row) => row.kind)).toEqual(["folder", "loading", "file"]);
  });

  test("a genuinely empty folder says that instead", () => {
    const rows = buildTreeRows({
      listings: { ...listings, "1-projects/plans": listing("1-projects/plans", []) },
      expanded: new Set(["1-projects", "1-projects/plans"]),
      selectedPath: null,
    });
    expect(rows.some((row) => row.kind === "empty")).toBe(true);
  });

  test("names in a folder, for collision checks", () => {
    expect([...namesIn(listings, "1-projects")].sort()).toEqual(["a.md", "pay.md", "plans"]);
    expect(namesIn(listings, "nowhere").size).toBe(0);
  });

  test("finding an entry by path", () => {
    expect(findEntry(listings, "1-projects/pay.md")?.exception).toBe(true);
    expect(findEntry(listings, "1-projects/ghost.md")).toBeNull();
  });
});

describe("only the folders a change touched are refetched", () => {
  test("a move refreshes both ends", () => {
    expect(foldersToRefresh(["1-projects/a.md", "2-areas/a.md"])).toEqual([
      "1-projects",
      "2-areas",
    ]);
  });

  test("a root-level change refreshes the root", () => {
    expect(foldersToRefresh(["index.md"])).toEqual([""]);
  });

  /** A folder default cascades, so everything loaded beneath it is stale. */
  test("a folder visibility change refreshes everything under it", () => {
    expect(
      foldersToRefresh(["1-projects"], {
        cascadeFrom: "1-projects",
        loaded: ["", "1-projects", "1-projects/plans", "2-areas"],
      }),
    ).toEqual(["", "1-projects", "1-projects/plans"]);
  });
});
