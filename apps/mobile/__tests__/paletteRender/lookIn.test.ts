/**
 * @jest-environment jsdom
 */

/**
 * A phone's search, beyond notes (boards 03 and 04 of the phone Home
 * artboards, approved by the owner on 2026-09-30): "Look in" chips before
 * anything is typed, counts on them once something is, the folders and tags
 * that match above the notes, and each opening what it names.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `Palette` ignoring `lookIn` on a phone.             → "before typing, Look in offers Notes, Folders and Tags"
 *  2. Notes drawn whatever the chip.                     → "Folders lists every folder and hides the notes; pressing it again widens"
 *  3. The All chip counting only notes.                  → "typed, the chips count where the matches are, and places come first"
 *  4. A tag row opening the folder handler.              → "a folder opens its page and a tag opens Home on it"
 *  5. `lookIn` drawn on a pointer layout too.            → "a pointer layout keeps ⌘K as it was"
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { lookInFor } from "../../features/console/layout/SearchLookIn";
import { DESKTOP, PHONE, mount } from "./fixtures";

const NOTES = [
  { path: "1-projects/launch-week/press.md", tags: ["launch"] },
  { path: "1-projects/launch-week/site.md", tags: ["launch"] },
];
const FOLDERS = ["1-projects", "1-projects/launch-week", "3-resources", "3-resources/notes-archive"];

function withLookIn(width: number) {
  const opened: string[] = [];
  const palette = mount(width, {
    lookIn: lookInFor({
      notes: NOTES,
      folders: FOLDERS,
      scope: null,
      rootLabel: "Northwind",
      onOpenFolder: (path) => opened.push(`folder:${path}`),
      onOpenTag: (tag) => opened.push(`tag:${tag}`),
    }),
  });
  const tap = (testID: string) => {
    const node = palette.find(testID)!;
    act(() => {
      for (const type of ["mousedown", "mouseup", "click"]) node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    });
  };
  const chips = () =>
    palette.all('[data-testid^="look-in-"][role="button"]').map((node) => node.getAttribute("aria-label"));
  return { palette, opened, tap, chips };
}

describe("a phone's search looks in notes, folders and tags", () => {
  test("before typing, Look in offers Notes, Folders and Tags", () => {
    const { palette, chips } = withLookIn(PHONE);
    expect(palette.find("search-look-in")!.textContent).toContain("Look in");
    expect(chips()).toEqual(["Notes", "Folders", "Tags"]);
    // Nothing narrowed yet: the notes are listed as they always were, and no places.
    expect(palette.find("palette-row-0")).not.toBeNull();
    expect(palette.find("search-places")).toBeNull();
    palette.unmount();
  });

  test("Folders lists every folder and hides the notes; pressing it again widens", () => {
    const { palette, tap } = withLookIn(PHONE);
    tap("look-in-folders");
    expect(palette.all('[data-testid="search-folder"]').map((row) => row.getAttribute("aria-label"))).toEqual([
      "launch-week, folder in projects, 2 notes",
      "notes-archive, folder in resources, Empty",
      "projects, folder in Northwind, 2 notes · 1 folder",
      "resources, folder in Northwind, 1 folder",
    ]);
    expect(palette.find("palette-row-0")).toBeNull();
    tap("look-in-folders");
    expect(palette.find("search-places")).toBeNull();
    expect(palette.find("palette-row-0")).not.toBeNull();
    palette.unmount();
  });

  test("Tags lists every tag with how many notes carry it", () => {
    const { palette, tap } = withLookIn(PHONE);
    tap("look-in-tags");
    expect(palette.all('[data-testid="search-tag"]').map((row) => row.getAttribute("aria-label"))).toEqual([
      "Tagged launch, 2 notes",
    ]);
    palette.unmount();
  });

  test("typed, the chips count where the matches are, and places come first", () => {
    const { palette, chips } = withLookIn(PHONE);
    palette.type("launch");
    const found = palette.all('[data-testid^="palette-row-"]').filter((row) => !row.textContent?.includes("See all")).length;
    expect(chips()).toEqual([`All, ${found + 2}`, `Notes, ${found}`, "Folders, 1", "Tags, 1"]);
    const places = palette.find("search-places")!;
    expect(places.textContent).toContain("Folders and tags");
    // The letters typed are marked in the name.
    expect(places.querySelector('[data-testid="search-mark"]')!.textContent).toBe("launch");
    palette.unmount();
  });

  test("the folders come above the notes, under their own heading", () => {
    const { palette } = withLookIn(PHONE);
    palette.type("note");
    const places = palette.find("search-places")!;
    const firstNote = palette.find("palette-row-0")!;
    expect(places.compareDocumentPosition(firstNote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(places.textContent).toContain("Notes");
    palette.unmount();
  });

  test("a folder opens its page and a tag opens Home on it", () => {
    const first = withLookIn(PHONE);
    first.palette.type("launch");
    first.tap("search-folder");
    expect(first.opened).toEqual(["folder:1-projects/launch-week"]);
    first.palette.unmount();

    const second = withLookIn(PHONE);
    second.palette.type("launch");
    second.tap("search-tag");
    expect(second.opened).toEqual(["tag:launch"]);
    second.palette.unmount();
  });

  test("a pointer layout keeps ⌘K as it was", () => {
    const { palette } = withLookIn(DESKTOP);
    palette.type("launch");
    expect(palette.find("search-look-in")).toBeNull();
    expect(palette.find("search-places")).toBeNull();
    palette.unmount();
  });
});
