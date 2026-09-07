/**
 * **What the breadcrumb says you are looking at.**
 *
 * From a phone, with two screenshots attached:
 *
 * > when you click on a workspace it puts it inside the breadcrumb. But
 * > clicking on the workspace name in the breadcrumb should take you to the
 * > root. Right now it doesn't do anything… It doesn't even show the rest of
 * > the items, what path you're in. The UX there is pretty broken; you're not
 * > able to really navigate.
 *
 * The second half of that is this file. The band drew the **ancestors** of the
 * open note and stopped — `1-projects/october-trip.md` rendered as
 * `@seyi / 1-projects`, and a note at the root (`index.md`, which is every
 * context's front page) rendered as `@seyi` and nothing else, over an open
 * editor. So the one line whose job is saying where you are said it about the
 * folder above you, and on the most common note in the product said nothing at
 * all.
 *
 * The argument for dropping the leaf was that the note names itself inside the
 * document, so a trailing segment is the same words twice. It is a real rule
 * (`ShareScreen` was fixed for exactly that) and it was applied to the wrong
 * element: the inline title is **inside the scroller**, so it is gone the
 * moment somebody reads past the first screen — and the breadcrumb is what is
 * left. A path that stops one segment short of where you are is not a shorter
 * path, it is a wrong one.
 *
 * ## Why this is a pure function with its own file
 *
 * Because two surfaces draw it — the phone's band and the pointer layout's
 * region header — and the last time they each decided for themselves what a
 * segment was, one of them lost the way up and shipped. The list of crumbs is
 * decided once, here; both renderers map over it. `breadcrumbRender.test.ts`
 * asserts that they do.
 */

import { describe, expect, test } from "@jest/globals";
import { crumbsFor, MAX_FOLDER_CRUMBS } from "../features/console/files/crumbs";

/** The labels, in order, with the gap drawn as the character it renders as. */
function labels(path: string, options?: Parameters<typeof crumbsFor>[1]): string[] {
  return crumbsFor(path, options).map((crumb) =>
    crumb.kind === "gap" ? "…" : crumb.label,
  );
}

describe("the path of the place you are in", () => {
  /**
   * The shipped defect, in one line. The note was open and the crumb named its
   * folder.
   *
   * SABOTAGE: restored `segments.slice(0, -1)` as the whole answer. Fails here.
   */
  test("a note is the last segment, not the folder above it", () => {
    expect(labels("1-projects/october-trip.md")).toEqual(["1-projects", "october-trip"]);
  });

  /**
   * The second screenshot: `@public-worship` lit, no path at all, and the open
   * note is that context's `index.md`. Every context has one and it is the
   * first thing anybody opens, so the empty answer was not an edge case.
   *
   * SABOTAGE: `if (folders.length === 0) return []`. Fails here.
   */
  test("index.md at the root is a segment, not nothing", () => {
    expect(labels("index.md")).toEqual(["index"]);
  });

  /** The extension is filing, not a name. `noteHeading` strips it too. */
  test("the leaf drops .md, and only at the end", () => {
    expect(labels("1-projects/notes.md/deep.md")).toEqual(["1-projects", "notes.md", "deep"]);
  });

  /**
   * A folder is a place as much as a note is. `FolderView` heads the page with
   * the folder's own name, which is the duplication the leaf was deleted over —
   * and that heading scrolls away exactly like a note's inline title does.
   */
  test("a folder you are standing in is the last segment too", () => {
    expect(labels("3-resources/books")).toEqual(["3-resources", "books"]);
    expect(labels("1-projects")).toEqual(["1-projects"]);
  });

  /**
   * The context's root. There is nothing to say that the pill in front of these
   * does not already say, so the crumbs are empty and the band draws the pill
   * alone.
   */
  test("the root itself has no segments — the pill is the root", () => {
    expect(crumbsFor("")).toEqual([]);
  });

  test("a leading or doubled slash does not invent an empty segment", () => {
    expect(labels("1-projects//trip.md")).toEqual(["1-projects", "trip"]);
  });

  /** What a folder segment presses to: its own listing, not its parent's. */
  test("every folder segment carries the path it opens", () => {
    const crumbs = crumbsFor("3-resources/books/reading/notes.md");
    expect(crumbs.map((crumb) => (crumb.kind === "gap" ? null : crumb.path))).toEqual([
      "3-resources",
      "3-resources/books",
      "3-resources/books/reading",
      "3-resources/books/reading/notes.md",
    ]);
    expect(crumbs.map((crumb) => crumb.kind)).toEqual(["folder", "folder", "folder", "leaf"]);
  });
});

describe("what a title does to the last segment", () => {
  /**
   * A captured note's filename is a content hash, so the segment naming what is
   * on screen named nothing. `noteHeading` resolves it and `BrowsePane` passes
   * the answer in — only when the editor is holding *this* note, or one note's
   * subject would sit over another note's name.
   */
  test("a title replaces the filename, and nothing else", () => {
    expect(labels("0-inbox/3efac11d4eead8832e5b1236.md", { title: "Airbnb, October" })).toEqual([
      "0-inbox",
      "Airbnb, October",
    ]);
  });

  test("a title is never applied to a folder segment", () => {
    const crumbs = crumbsFor("0-inbox/note.md", { title: "Something" });
    expect(crumbs[0]).toEqual({ kind: "folder", label: "0-inbox", path: "0-inbox" });
  });
});

describe("fitting a deep path on a 390pt screen", () => {
  /**
   * The band scrolls, and scrolling is not an answer for the segment that says
   * *where you are*: it starts off-screen and stays there until somebody thinks
   * to drag a row they have no reason to think is draggable. So the number of
   * folder segments is capped and the middle ones are elided.
   *
   * **No segment's own text is ever truncated** — that is `ContextStrip`'s rule
   * and it is untouched: two folders ellipsised to `3-resour…` are two folders
   * that look identical on the control whose job is telling them apart. What is
   * capped is how many of them are drawn.
   *
   * SABOTAGE: removed the elision. Fails here.
   */
  test("more than three folders elides the middle, never the last", () => {
    expect(labels("a/b/c/d/note.md")).toEqual(["a", "…", "c", "d", "note"]);
    expect(labels("a/b/c/d/e/f/note.md")).toEqual(["a", "…", "e", "f", "note"]);
  });

  test("three folders or fewer are drawn whole", () => {
    expect(MAX_FOLDER_CRUMBS).toBe(3);
    expect(labels("a/b/c/note.md")).toEqual(["a", "b", "c", "note"]);
  });

  /**
   * The leaf is never the thing that goes. It is the answer to the question the
   * line is asked.
   *
   * SABOTAGE: elided from the end instead of the middle. Fails here.
   */
  test("the last segment survives every depth", () => {
    for (let depth = 0; depth < 12; depth += 1) {
      const path = `${Array.from({ length: depth }, (_, i) => `f${i}`).join("/")}/note.md`;
      const crumbs = crumbsFor(path);
      expect(crumbs[crumbs.length - 1]).toEqual({
        kind: "leaf",
        label: "note",
        path,
      });
    }
  });

  /**
   * The gap says which folders it is standing in for, so a screen reader is not
   * told "ellipsis" and left there. Those folders are still reachable: the
   * first segment is drawn and pressing it lists what is under it.
   */
  test("the gap names what it hides", () => {
    const gap = crumbsFor("a/b/c/d/e/note.md").find((crumb) => crumb.kind === "gap");
    expect(gap).toEqual({ kind: "gap", hidden: ["b", "c"] });
  });

  /**
   * The pointer layout has the width for the whole path and a chip beside it,
   * so it asks for no cap. Same function, same crumbs, one argument apart —
   * which is the point of the function existing.
   */
  test("a caller with room asks for none", () => {
    expect(labels("a/b/c/d/e/note.md", { maxFolders: null })).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "note",
    ]);
  });
});
