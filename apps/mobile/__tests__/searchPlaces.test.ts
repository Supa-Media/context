import { describe, expect, test } from "@jest/globals";
import { PLACE_LIMIT, findPlaces } from "../features/console/home/searchPlaces";

/**
 * The folders and tags a phone's search finds (board 04 of the phone Home
 * artboards, approved by the owner on 2026-09-30): each folder with where it
 * is and what it holds, each tag with how many notes carry it, and the
 * letters typed marked so the row shows why it is there.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `scope` ignored.                              → "Search in a folder finds only what is inside it"
 *  2. Prefix matches not sorted first.              → "a folder's name matched, with where it is and what it holds"
 *  3. A tag counted twice on a note that repeats it. → "tags count the notes that carry them"
 *  4. An empty query listing nothing.               → "nothing typed lists every folder and tag, busiest tag first"
 */

const NOTES = [
  { path: "1-projects/launch-week/press.md", tags: ["launch"] },
  { path: "1-projects/launch-week/site.md", tags: ["launch", "launch", "web"] },
  { path: "1-projects/relaunch/plan.md", tags: [] },
  { path: "3-resources/brand/logo.md", tags: ["launch"] },
  { path: "index.md", tags: ["home"] },
];
const FOLDERS = ["1-projects", "1-projects/launch-week", "1-projects/relaunch", "3-resources", "3-resources/brand"];

describe("folders and tags in search", () => {
  test("a folder's name matched, with where it is and what it holds", () => {
    const { folders } = findPlaces({ query: "Launch", notes: NOTES, folders: FOLDERS, rootLabel: "Northwind" });
    expect(folders.map((hit) => hit.path)).toEqual(["1-projects/launch-week", "1-projects/relaunch"]);
    expect(folders[0]).toEqual({
      path: "1-projects/launch-week",
      label: "launch-week",
      where: "projects",
      counts: "2 notes",
      ranges: [[0, 6]],
    });
    expect(folders[1]!.ranges).toEqual([[2, 8]]);
  });

  test("a folder at the top says it is in the workspace", () => {
    const { folders } = findPlaces({ query: "res", notes: NOTES, folders: FOLDERS, rootLabel: "Northwind" });
    expect(folders[0]).toMatchObject({ path: "3-resources", where: "Northwind", counts: "1 note · 1 folder" });
  });

  test("tags count the notes that carry them", () => {
    const { tags } = findPlaces({ query: "lau", notes: NOTES, folders: FOLDERS, rootLabel: "Northwind" });
    expect(tags).toEqual([{ tag: "launch", count: 3, ranges: [[0, 3]] }]);
  });

  test("Search in a folder finds only what is inside it", () => {
    const hits = findPlaces({ query: "launch", notes: NOTES, folders: FOLDERS, scope: "1-projects", rootLabel: "Northwind" });
    expect(hits.folders.map((hit) => hit.path)).toEqual(["1-projects/launch-week", "1-projects/relaunch"]);
    expect(hits.tags).toEqual([{ tag: "launch", count: 2, ranges: [[0, 6]] }]);
    const brand = findPlaces({ query: "brand", notes: NOTES, folders: FOLDERS, scope: "1-projects", rootLabel: "Northwind" });
    expect(brand.folders).toEqual([]);
  });

  test("nothing typed lists every folder and tag, busiest tag first", () => {
    const hits = findPlaces({ query: "", notes: NOTES, folders: FOLDERS, rootLabel: "Northwind" });
    expect(hits.folders).toHaveLength(FOLDERS.length);
    expect(hits.tags.map((hit) => hit.tag)).toEqual(["launch", "home", "web"]);
    expect(hits.folders.every((hit) => hit.ranges.length === 0)).toBe(true);
  });

  test("a long answer is cut at the limit", () => {
    const many = Array.from({ length: PLACE_LIMIT + 5 }, (_, index) => `f${index}`);
    expect(findPlaces({ query: "f", notes: [], folders: many, rootLabel: "N" }).folders).toHaveLength(PLACE_LIMIT);
  });
});
