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
import {
  crumbsFor,
  CHAR_WIDTH_PX,
  MAX_FOLDER_CRUMBS,
  SEPARATOR_CHARS,
} from "../features/console/files/crumbs";

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
    // `maxFolders: null` so this is about the paths rather than about the cap,
    // which the last block of this file is the subject of.
    const crumbs = crumbsFor("3-resources/books/reading/notes.md", { maxFolders: null });
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
   * The band scrolls, and scrolling is a poor answer for the segment that says
   * *where you are*: it starts off-screen and stays there until somebody thinks
   * to drag a row they have no reason to think is draggable. So the number of
   * folder segments is capped and the middle ones are elided — the root folder
   * and the immediate parent kept, which is the classic breadcrumb shape.
   *
   * **No segment's own text is ever truncated** — that is `ContextStrip`'s rule
   * and it is untouched: two folders ellipsised to `3-resour…` are two folders
   * that look identical on the control whose job is telling them apart. What is
   * capped is how many of them are drawn.
   *
   * The cap does not *guarantee* a fit and cannot — segment names are the
   * customer's, so no count is a width. `crumbs.ts` records what was measured
   * in a browser at 390pt and what the cap actually buys.
   *
   * SABOTAGE: removed the elision. Fails here.
   */
  test("more than two folders elides the middle, never the last", () => {
    expect(labels("a/b/c/note.md")).toEqual(["a", "…", "c", "note"]);
    expect(labels("a/b/c/d/e/f/note.md")).toEqual(["a", "…", "f", "note"]);
  });

  test("two folders or fewer are drawn whole", () => {
    expect(MAX_FOLDER_CRUMBS).toBe(2);
    expect(labels("a/b/note.md")).toEqual(["a", "b", "note"]);
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
    expect(gap).toEqual({ kind: "gap", hidden: ["b", "c", "d"] });
  });

  /**
   * The root folder is kept as well as the parent, and both are pressable.
   * That is what stops the elision hiding anything for good: the PARA bucket is
   * one press away and its listing is how anybody reached the middle folders in
   * the first place.
   */
  test("the two folders kept are the root and the immediate parent, both live", () => {
    const crumbs = crumbsFor("3-resources/books/reading/notes.md");
    expect(crumbs.map((crumb) => (crumb.kind === "gap" ? "…" : crumb.path))).toEqual([
      "3-resources",
      "…",
      "3-resources/books/reading",
      "3-resources/books/reading/notes.md",
    ]);
  });

  /**
   * The cap is a cap, at every depth and every setting — the property the
   * hand-written cases above are examples of, and the one a future edit to the
   * slicing would break silently.
   *
   * SABOTAGE: `slice(-(maxFolders - 1))` with the floor removed, then
   * `maxFolders: 1`. Fails here with the *whole* path returned, an ellipsis in
   * the middle of it — which is what `slice(-0)` means and what the floor in
   * `crumbsFor` exists to stop.
   */
  test("never more folder segments than the cap, whatever it is asked for", () => {
    for (const cap of [1, 2, 3, 5]) {
      for (let depth = 0; depth < 10; depth += 1) {
        const path = `${Array.from({ length: depth }, (_, i) => `f${i}`).join("/")}/note.md`;
        const folders = crumbsFor(path, { maxFolders: cap }).filter(
          (crumb) => crumb.kind === "folder",
        );
        expect(folders.length).toBeLessThanOrEqual(Math.max(2, cap));
      }
    }
  });

  /**
   * A gap stands for folders, so a gap standing for none is a mark that means
   * nothing — worse than either answer it sits between.
   *
   * SABOTAGE: floored the cap *after* the "is it short enough" comparison
   * instead of before it, then `maxFolders: 1`. Fails here on `a/b/note.md`,
   * which elides two folders into first-gap-last over the same two.
   */
  test("a gap always stands for at least one folder", () => {
    for (const cap of [1, 2, 3]) {
      for (let depth = 0; depth < 8; depth += 1) {
        const path = `${Array.from({ length: depth }, (_, i) => `f${i}`).join("/")}/note.md`;
        for (const crumb of crumbsFor(path, { maxFolders: cap })) {
          if (crumb.kind === "gap") expect(crumb.hidden.length).toBeGreaterThan(0);
        }
      }
    }
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

/**
 * **The leaf must never be the segment that goes off screen.**
 *
 * `MAX_FOLDER_CRUMBS` bounds the row; it does not fit it — the cap's own
 * comment says so, and the two screenshots that came out of it are the
 * defect this block exists to close: `1-note-two-folders-deep.png` clipped
 * "Org chart" behind the trailing fade, and `5-deep-path-elided.png` cut
 * "the-lean-startup" to "the-lean-sta…" the same way. A `budget` is a caller
 * saying it needs the fit *guaranteed*, and past this point nothing that goes
 * missing is allowed to go missing silently: a folder collapses to a `…` that
 * still says "there is more here", and only the leaf's own label is ever
 * shortened — visibly, in the middle, never by scrolling an unmarked edge
 * past the glass.
 */
describe("protecting the leaf with a character budget", () => {
  /** Comfortably inside budget: nothing changes. */
  test("a budget with room to spare changes nothing", () => {
    expect(labels("1-projects/october-trip.md", { budget: { chars: 200 } })).toEqual([
      "1-projects",
      "october-trip",
    ]);
  });

  /**
   * Too tight for the capped shape (root, gap, parent, leaf) but roomy enough
   * for the harder collapse: every folder becomes the one `…` standing for
   * "there is a path above this", and the leaf survives whole.
   *
   * SABOTAGE: budget ignored once `maxFolders` has already run. Fails here —
   * `books` and `reading` would still be drawn.
   */
  test("a budget the cap alone cannot meet collapses every folder", () => {
    const crumbs = crumbsFor("3-resources/books/reading/notes.md", { budget: { chars: 20 } });
    expect(crumbs.map((crumb) => (crumb.kind === "gap" ? "…" : crumb.label))).toEqual([
      "…",
      "notes",
    ]);
    expect(crumbs.find((crumb) => crumb.kind === "gap")).toEqual({
      kind: "gap",
      hidden: ["3-resources", "books", "reading"],
    });
  });

  /**
   * The immediate parent is worth keeping pressable longer than the root: it
   * is the one "step back" actually reaches, where the pill in front of this
   * row already reaches the root. So folders give way from the *front* —
   * oldest ancestor first — rather than jumping straight to one bare `…`.
   */
  test("the immediate parent stays a live folder as long as it can", () => {
    const crumbs = crumbsFor("reallyreallylongrootfoldername/x/note-name.md", {
      budget: { chars: 24 },
    });
    expect(crumbs).toEqual([
      { kind: "gap", hidden: ["reallyreallylongrootfoldername"] },
      { kind: "folder", label: "x", path: "reallyreallylongrootfoldername/x" },
      { kind: "leaf", label: "note-name", path: "reallyreallylongrootfoldername/x/note-name.md" },
    ]);
  });

  test("a root-level note has no folder to collapse, only itself", () => {
    const crumbs = crumbsFor("the-lean-startup.md", { budget: { chars: 6 } });
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]!.kind).toBe("leaf");
  });

  /**
   * The last resort, and the one the report's screenshots are about: the
   * leaf's own name is what does not fit, once there is nothing left of the
   * path to give up. It is cut in the middle, not at an edge — `the-lean` and
   * `startup` both survive, which is what tells someone this is the note they
   * were looking for rather than a different one with the same prefix.
   *
   * SABOTAGE: truncated from the end (`slice(0, maxChars - 1) + "…"`). Fails
   * here — the label would start with `the-lean-star` rather than keep a
   * piece of both ends.
   */
  test("only once folders give up everything is the leaf itself shortened", () => {
    const crumbs = crumbsFor("3-resources/books/reading-notes/2026/the-lean-startup.md", {
      budget: { chars: 20 },
    });
    // Folders are already at their hardest collapse — one gap standing for
    // all four of them — before the leaf gives up anything of its own.
    expect(crumbs[0]).toEqual({
      kind: "gap",
      hidden: ["3-resources", "books", "reading-notes", "2026"],
    });
    const leaf = crumbs[1] as { kind: string; label: string; fullLabel?: string };
    expect(leaf.kind).toBe("leaf");
    // A cut in the middle, not at an edge: both the word somebody typed at the
    // front of the name and the word at the end of it survive.
    expect(leaf.label).toBe("the-l…artup");
    // The full name is not lost — it travels for a screen reader to read.
    expect(leaf.fullLabel).toBe("the-lean-startup");
  });

  test("a leaf within budget carries no fullLabel — it was never shortened", () => {
    const crumbs = crumbsFor("1-projects/october-trip.md", { budget: { chars: 200 } });
    const leaf = crumbs.find((crumb) => crumb.kind === "leaf");
    expect(leaf?.fullLabel).toBeUndefined();
  });

  /**
   * The property the hand-written cases above are examples of: whatever the
   * budget, and however deep the path, the row this function returns never
   * costs more characters than it was given — one separator per crumb plus
   * its own text, `…` counted as the one character it renders as.
   *
   * Budgets below 10 are not asserted: the smallest possible shape with a
   * folder to collapse — a gap plus a one-character leaf, `SEPARATOR_CHARS`
   * in front of each — already costs 10, and a caller offering less than that
   * is asking for something with no answer. No real screen does;
   * `Breadcrumb`'s narrowest supported width is nowhere near it.
   *
   * SABOTAGE: the leaf-truncation branch skipped (`return collapsed`
   * unconditionally past the second budget check). Fails at every budget
   * once the leaf alone is longer than it.
   */
  test("the row never spends more characters than its budget, at any depth", () => {
    const rowChars = (path: string, chars: number): number =>
      crumbsFor(path, { budget: { chars } }).reduce(
        (total, crumb) => total + SEPARATOR_CHARS + (crumb.kind === "gap" ? 1 : crumb.label.length),
        0,
      );
    for (const chars of [10, 14, 20, 40, 100]) {
      for (let depth = 0; depth < 6; depth += 1) {
        const folders = Array.from({ length: depth }, (_, i) => `folder-${i}`).join("/");
        const path = `${depth === 0 ? "" : `${folders}/`}a-fairly-long-note-name-for-a-test.md`;
        expect(rowChars(path, chars)).toBeLessThanOrEqual(chars);
      }
    }
  });

  /** The leaf is drawn at every depth and every budget — never dropped, only shortened. */
  test("the leaf is never the segment that disappears, whatever the budget", () => {
    for (const chars of [4, 6, 8, 14, 40]) {
      for (let depth = 0; depth < 6; depth += 1) {
        const folders = Array.from({ length: depth }, (_, i) => `folder-${i}`).join("/");
        const path = `${depth === 0 ? "" : `${folders}/`}a-fairly-long-note-name-for-a-test.md`;
        const crumbs = crumbsFor(path, { budget: { chars } });
        const leaf = crumbs[crumbs.length - 1];
        expect(leaf?.kind).toBe("leaf");
        expect((leaf as { label: string }).label.length).toBeGreaterThan(0);
      }
    }
  });

  /** `CHAR_WIDTH_PX` is a real number a caller multiplies pixels by, not a placeholder. */
  test("the char width is a positive, sub-glyph-sized number of points", () => {
    expect(CHAR_WIDTH_PX).toBeGreaterThan(0);
    expect(CHAR_WIDTH_PX).toBeLessThan(20);
  });
});
