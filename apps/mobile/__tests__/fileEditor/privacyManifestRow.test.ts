/**
 * `privacy.md` is not a row.
 *
 * The owner, 2026-09-26: "no need to show it to people". It is generated from
 * the visibility settings, read-only in the console, and everything it says is
 * already drawn on the rows it governs. So the console unlists it the way it
 * unlists a folder's placeholder, and for the same reasons keeps it reachable:
 * the file stays in the bucket, the server listing still returns it, agents and
 * Obsidian still read it, and the tree draws it while it is the open note.
 *
 * SABOTAGE: dropping `isPrivacyManifest` from `isUnlistedFile` fails the tree,
 * folder-order and counts tests here. Dropping the palette checks fails the two
 * palette tests. Matching any `privacy.md` rather than the root one fails "a
 * privacy.md in a folder is somebody's note".
 */

import { describe, expect, test } from "@jest/globals";
import { isPrivacyManifest } from "../../features/console/files/paths";
import { buildTreeRows, listedEntries, namesIn } from "../../features/console/files/tree";
import { loadedCounts } from "../../features/console/files/contextFoot";
import { itemsFromListings, itemsFromPaths } from "../../features/console/files/palette";
import { file, folder, listing } from "./fixtures";

const manifest = file("privacy.md", { readOnly: true });

describe("the privacy manifest", () => {
  test("is the root privacy.md, folded as the gateway folds it", () => {
    expect(isPrivacyManifest("privacy.md")).toBe(true);
    expect(isPrivacyManifest("Privacy.MD")).toBe(true);
  });

  test("a privacy.md in a folder is somebody's note", () => {
    expect(isPrivacyManifest("1-projects/privacy.md")).toBe(false);
    expect(isPrivacyManifest("privacy-policy.md")).toBe(false);
  });

  test("the tree draws every other root row and not this one", () => {
    const rows = buildTreeRows({
      listings: {
        "": listing("", [folder("1-projects"), file("index.md"), manifest, file("todo.md")]),
      },
      expanded: new Set(),
      selectedPath: null,
    });
    expect(rows.map((row) => row.path)).toEqual(["1-projects", "index.md", "todo.md"]);
  });

  test("it is drawn while it is the note you are looking at", () => {
    const rows = buildTreeRows({
      listings: { "": listing("", [file("index.md"), manifest]) },
      expanded: new Set(),
      selectedPath: "privacy.md",
    });
    const open = rows.find((row) => row.path === "privacy.md");
    expect(open?.selected).toBe(true);
    // Still marked read-only, so the row keeps saying what it is while drawn.
    expect(open?.readOnly).toBe(true);
  });

  test("the folder page drops it too, because it reads the same filter", () => {
    expect(listedEntries([file("index.md"), manifest]).map((entry) => entry.path)).toEqual([
      "index.md",
    ]);
  });

  test("a collision check still sees it, because the bucket does", () => {
    const listings = { "": listing("", [manifest]) };
    expect(namesIn(listings, "").has("privacy.md")).toBe(true);
  });

  test("the counts line does not count it", () => {
    expect(loadedCounts({ "": listing("", [file("index.md"), manifest]) })).toBe(
      "1 note, 0 folders",
    );
  });

  test("quick open does not offer it from the loaded listings", () => {
    const items = itemsFromListings({ "": listing("", [file("index.md"), manifest]) });
    expect(items.map((item) => item.id)).toEqual(["index.md"]);
  });

  test("quick open does not offer it from the device's copy either", () => {
    const items = itemsFromPaths(["privacy.md", "1-projects/privacy.md"], []);
    expect(items.map((item) => item.id)).toEqual(["1-projects/privacy.md", "1-projects"]);
  });
});
