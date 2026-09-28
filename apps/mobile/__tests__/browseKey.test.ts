/**
 * The phone's folder key: the whole tree, as a sheet.
 *
 * Owner-approved on 2026-09-28 (phone bottom bar artboard, option B). The key
 * used to open the folder page of the note on screen, which was "up a level"
 * under a folder glyph. It now raises `TreeSheet`, never dimmed. The two
 * decisions in the sheet are pure and pinned here: which folders open so the
 * note on screen is a visible row, and what a tap on a row does. That the key
 * is on the row is `bottomRowWidth.test.ts`; the sheet in a browser is
 * `e2e/webkit/homeNavigation.spec.ts`.
 *
 * SABOTAGE: `foldersToReveal` returning `[]` fails the reveal cases (the note
 * on screen would sit inside a collapsed branch); `treeSheetTap` answering
 * "open" for a folder fails the tap case (a folder tap would close the sheet
 * onto a folder page, the old key's behaviour).
 */

import { describe, expect, test } from "@jest/globals";
import { foldersToReveal, treeSheetTap } from "../features/console/files/TreeSheet";

describe("the tree sheet", () => {
  test("opens every closed folder above the note on screen, outermost first", () => {
    expect(foldersToReveal("1-projects/trips/plan.md", new Set())).toEqual(["1-projects", "1-projects/trips"]);
  });

  test("leaves folders already open alone", () => {
    expect(foldersToReveal("1-projects/trips/plan.md", new Set(["1-projects"]))).toEqual(["1-projects/trips"]);
  });

  test("has nothing to open for a top-level note or with nothing open", () => {
    expect(foldersToReveal("todo.md", new Set())).toEqual([]);
    expect(foldersToReveal(null, new Set())).toEqual([]);
  });

  test("a note opens and a folder folds in place", () => {
    expect(treeSheetTap({ kind: "file", path: "todo.md" })).toBe("open");
    expect(treeSheetTap({ kind: "folder", path: "1-projects" })).toBe("toggle");
    expect(treeSheetTap({ kind: "loading", path: "1-projects" })).toBeNull();
  });
});
