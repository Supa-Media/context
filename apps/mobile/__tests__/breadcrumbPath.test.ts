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
 * decided once, here; both renderers map over it. `noteChrome.test.ts`'s "the
 * path bar" asserts that they do, against the real mounted console.
 *
 * ## What used to live below, and does not any more
 *
 * This file once carried two more `describe` blocks: a folder count capped at
 * `MAX_FOLDER_CRUMBS` with the middle elided to a `{ kind: "gap" }` crumb, and
 * a character `budget` (`CHAR_WIDTH_PX`, `SEPARATOR_CHARS`, `phoneRowBudget`)
 * that shortened the leaf itself once folders had nothing left to give up. Both
 * existed to answer "does the leaf fit on a 390pt row" without a scroll, and
 * both are gone: `NavBand`'s row is a horizontal `ScrollView`, and a scroller
 * answers that question for free, correctly, at every width and every font
 * size — which a folder count or a pixel estimate could only approximate.
 * `crumbs.ts`'s header carries the fuller argument, and
 * `docs/decisions/app-and-console.md`'s "Two, not three" and "A count cannot
 * guarantee a fit, so a width budget does" are marked superseded rather than
 * deleted, because the constraint they solved (width) is what expired, not the
 * reasoning.
 */

import { describe, expect, test } from "@jest/globals";
import { crumbsFor } from "../features/console/files/crumbs";

/** The labels, in order. */
function labels(path: string, options?: Parameters<typeof crumbsFor>[1]): string[] {
  return crumbsFor(path, options).map((crumb) => crumb.label);
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
    expect(crumbs.map((crumb) => crumb.path)).toEqual([
      "3-resources",
      "3-resources/books",
      "3-resources/books/reading",
      "3-resources/books/reading/notes.md",
    ]);
    expect(crumbs.map((crumb) => crumb.kind)).toEqual(["folder", "folder", "folder", "leaf"]);
  });

  /**
   * The property the elision used to trade away and no longer has to: every
   * folder on the path is drawn, whatever the depth, in order, and nothing
   * stands in for a hidden one.
   *
   * SABOTAGE: restored the cap-and-collapse branch from before this file was
   * cut down (`folders.length <= cap ? whole : collapse`). Fails here — a
   * seven-folder path would come back as `a, …, g, note` instead of every
   * name.
   */
  test("a deep path draws every folder, in order, with nothing eliding", () => {
    const path = "a/b/c/d/e/f/g/note.md";
    const crumbs = crumbsFor(path);
    expect(crumbs.map((crumb) => crumb.kind)).toEqual([
      "folder",
      "folder",
      "folder",
      "folder",
      "folder",
      "folder",
      "folder",
      "leaf",
    ]);
    expect(crumbs.map((crumb) => crumb.label)).toEqual(["a", "b", "c", "d", "e", "f", "g", "note"]);
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

/*
  The touch-target claim — "every folder segment is a target a thumb can
  hit" — moved to `noteChrome.test.ts`, which mounts the real component tree.
  It used to live here as an assertion over a `hitSlop` object this module
  never touches, which was a workaround for react-native-web dropping
  `hitSlop` before it reaches the DOM (see `Breadcrumb.tsx`'s `segment`
  style): a jsdom test could hold the constant fed to `hitSlop`, but never see
  whether the box a browser actually hit-tests against grew to match it — and,
  measured live in a real Chromium build of this page, it never did. The fix
  is `segment`'s own `minHeight`, a real layout property a rendered assertion
  can see, so the claim now belongs where rendering happens.
*/

