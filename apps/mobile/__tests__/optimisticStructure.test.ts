/**
 * Moving a folder repaints the tree now, not a round trip from now.
 *
 * The complaint this exists for: renaming or moving a folder in the sidebar
 * left the console showing the old shape until the mutation *and* every
 * listing refetch it triggered had come back. On a deep expanded tree that is
 * one action followed by several seconds of a stale picture and a disabled
 * toolbar — and the subtree collapsed when it finally arrived, because its
 * listings were still keyed under a path the bucket no longer has.
 *
 * `optimistic.ts` is the pure half of the fix: given the listings on screen,
 * it says what they look like the instant the operation is applied. The hook
 * paints that, sends the mutation, and reconciles with the server's answer.
 *
 * These are unit tests of a module with no React in it, per `jest.config.js`.
 * What they hold is the part a component test cannot see: that the subtree
 * travels with the folder rather than being dropped, that the ordering is the
 * server's own, and that the inverse really is the inverse — because the
 * inverse is what runs when the mutation fails.
 */

import { describe, expect, test } from "@jest/globals";
import {
  applyFolderCreate,
  applyMove,
  rekeyPath,
  rekeyPaths,
  undoFolderCreate,
} from "../features/console/files/optimistic";
import type { FileEntry, FolderListing } from "../features/console/files/types";

function entry(over: Partial<FileEntry> & Pick<FileEntry, "path">): FileEntry {
  return {
    kind: over.path.endsWith(".md") ? "file" : "folder",
    name: over.path.slice(over.path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...over,
  } as FileEntry;
}

function listing(path: string, paths: readonly string[]): FolderListing {
  return {
    path,
    folderDefault: "private",
    entries: paths.map((one) => entry({ path: one })),
    truncated: false,
    manifestUsable: true,
  };
}

/** A root with `1-projects/foo` two levels deep, all of it loaded. */
function loaded(): Record<string, FolderListing | undefined> {
  return {
    "": listing("", ["1-projects", "2-areas", "index.md"]),
    "1-projects": listing("1-projects", ["1-projects/foo", "1-projects/loose.md"]),
    "1-projects/foo": listing("1-projects/foo", ["1-projects/foo/deep", "1-projects/foo/a.md"]),
    "1-projects/foo/deep": listing("1-projects/foo/deep", ["1-projects/foo/deep/b.md"]),
    "2-areas": listing("2-areas", ["2-areas/health.md"]),
  };
}

const names = (l: FolderListing | undefined): string[] => (l?.entries ?? []).map((e) => e.path);

/* -------------------------------------------------------------------------- */
/*                                   a move                                   */
/* -------------------------------------------------------------------------- */

describe("applyMove", () => {
  test("takes the entry out of one parent and puts it in the other", () => {
    const next = applyMove(loaded(), "1-projects/foo", "2-areas/foo");
    expect(names(next["1-projects"])).toEqual(["1-projects/loose.md"]);
    expect(names(next["2-areas"])).toContain("2-areas/foo");
  });

  test("keeps the server's order — folders first, then names", () => {
    const next = applyMove(loaded(), "1-projects/foo", "2-areas/foo");
    expect(names(next["2-areas"])).toEqual(["2-areas/foo", "2-areas/health.md"]);
  });

  test("the whole subtree travels, re-keyed, so nothing collapses", () => {
    const next = applyMove(loaded(), "1-projects/foo", "2-areas/foo");
    expect(next["1-projects/foo"]).toBeUndefined();
    expect(next["1-projects/foo/deep"]).toBeUndefined();
    expect(names(next["2-areas/foo"])).toEqual(["2-areas/foo/deep", "2-areas/foo/a.md"]);
    expect(names(next["2-areas/foo/deep"])).toEqual(["2-areas/foo/deep/b.md"]);
    expect(next["2-areas/foo"]?.path).toBe("2-areas/foo");
  });

  test("a rename is a move inside one folder, and the subtree still travels", () => {
    const next = applyMove(loaded(), "1-projects/foo", "1-projects/bar");
    expect(names(next["1-projects"])).toEqual(["1-projects/bar", "1-projects/loose.md"]);
    expect(names(next["1-projects/bar/deep"])).toEqual(["1-projects/bar/deep/b.md"]);
  });

  test("a note moves without needing a listing of its own", () => {
    const next = applyMove(loaded(), "1-projects/loose.md", "2-areas/loose.md");
    expect(names(next["1-projects"])).toEqual(["1-projects/foo"]);
    expect(names(next["2-areas"])).toEqual(["2-areas/health.md", "2-areas/loose.md"]);
  });

  test("it is the inverse of itself, which is what a failed mutation runs", () => {
    const before = loaded();
    const there = applyMove(before, "1-projects/foo", "2-areas/foo");
    const back = applyMove(there, "2-areas/foo", "1-projects/foo");
    expect(Object.keys(back).sort()).toEqual(Object.keys(before).sort());
    for (const key of Object.keys(before)) expect(names(back[key])).toEqual(names(before[key]));
  });

  test("a destination whose listing has not been fetched is left alone", () => {
    // Nothing may be invented for a folder nobody has read: the row would be
    // the only one in it, and the folder would draw as holding one note.
    const next = applyMove(loaded(), "1-projects/loose.md", "4-archive/loose.md");
    expect(next["4-archive"]).toBeUndefined();
    expect(names(next["1-projects"])).toEqual(["1-projects/foo"]);
  });

  test("the input is not mutated", () => {
    const before = loaded();
    applyMove(before, "1-projects/foo", "2-areas/foo");
    expect(names(before["1-projects"])).toEqual(["1-projects/foo", "1-projects/loose.md"]);
    expect(before["1-projects/foo"]).toBeDefined();
  });

  test("a path that is not there changes nothing", () => {
    const before = loaded();
    const next = applyMove(before, "1-projects/ghost.md", "2-areas/ghost.md");
    expect(names(next["2-areas"])).toEqual(["2-areas/health.md"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                a new folder                                */
/* -------------------------------------------------------------------------- */

describe("applyFolderCreate", () => {
  test("draws the folder and an empty listing for it", () => {
    const next = applyFolderCreate(loaded(), "1-projects/new");
    expect(names(next["1-projects"])).toEqual([
      "1-projects/foo",
      "1-projects/new",
      "1-projects/loose.md",
    ]);
    expect(next["1-projects/new"]?.entries).toEqual([]);
  });

  test("it inherits the parent's default rather than claiming to be private", () => {
    const base = loaded();
    base["1-projects"] = { ...base["1-projects"]!, folderDefault: "team" };
    const next = applyFolderCreate(base, "1-projects/new");
    expect(next["1-projects/new"]?.folderDefault).toBe("team");
    const row = next["1-projects"]?.entries.find((one) => one.path === "1-projects/new");
    expect(row?.visibility).toBe("team");
    expect(row?.exception).toBe(false);
  });

  test("undoFolderCreate puts it back exactly", () => {
    const before = loaded();
    const back = undoFolderCreate(applyFolderCreate(before, "1-projects/new"), "1-projects/new");
    expect(Object.keys(back).sort()).toEqual(Object.keys(before).sort());
    expect(names(back["1-projects"])).toEqual(names(before["1-projects"]));
  });
});

/* -------------------------------------------------------------------------- */
/*                      what the rest of the console holds                    */
/* -------------------------------------------------------------------------- */

describe("rekeyPath", () => {
  test("follows the moved path itself", () => {
    expect(rekeyPath("1-projects/foo", "1-projects/foo", "2-areas/foo")).toBe("2-areas/foo");
  });

  test("follows anything under it", () => {
    expect(rekeyPath("1-projects/foo/deep/b.md", "1-projects/foo", "2-areas/foo")).toBe(
      "2-areas/foo/deep/b.md",
    );
  });

  test("leaves a sibling whose name merely starts the same alone", () => {
    // `1-projects/foobar` is not under `1-projects/foo`, and a prefix test
    // without the slash would have moved it.
    expect(rekeyPath("1-projects/foobar", "1-projects/foo", "2-areas/foo")).toBe(
      "1-projects/foobar",
    );
  });

  test("null stays null", () => {
    expect(rekeyPath(null, "a", "b")).toBeNull();
  });

  test("rekeyPaths carries the expanded set across", () => {
    const next = rekeyPaths(
      new Set(["1-projects", "1-projects/foo", "1-projects/foo/deep", "1-projects/foobar"]),
      "1-projects/foo",
      "2-areas/foo",
    );
    expect([...next].sort()).toEqual([
      "1-projects",
      "1-projects/foobar",
      "2-areas/foo",
      "2-areas/foo/deep",
    ]);
  });
});
