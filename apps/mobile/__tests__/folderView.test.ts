/**
 * @jest-environment jsdom
 */

/**
 * A FOLDER IS SOMEWHERE YOU ARE, NOT A SETTINGS PANEL ABOUT ONE.
 *
 * Reported from a phone with a screenshot: tapping a folder gave its path, one
 * sentence about visibility, a "Make this folder private" button, and then most
 * of the screen empty. It was also the *only* thing a folder did — the notes
 * inside it were reachable only through the tree drawer, which is the surface a
 * phone makes hardest to reach.
 *
 * The property with teeth is the last group below. **This must never claim a
 * folder is empty when it is full of notes the reader may not see.** The rows
 * come from the listing the server already filtered at the caller's scope, so
 * "nothing here" and "nothing here *for you*" are two different sentences and
 * the code has to say the right one.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

// React refuses to run `act` without this, and warns on every call otherwise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { noteColumnWidth, noteGutterFor } from "../features/app/frame";
import { layout } from "../features/design/tokens";
import { FolderView } from "../features/console/files/FolderView";
import type { FileEntry, FolderListing } from "../features/console/files/types";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const FOLDER = "1-projects/pilot";

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  kind: "folder",
  path: FOLDER,
  name: "pilot",
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
  ...over,
});

const file = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({
  kind: "file",
  path: `${FOLDER}/${name}`,
  name,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
  ...over,
});

const listing = (entries: FileEntry[], over: Partial<FolderListing> = {}): FolderListing => ({
  path: FOLDER,
  folderDefault: "team",
  entries,
  truncated: false,
  manifestUsable: true,
  ...over,
});

interface Mounted {
  container: HTMLElement;
  selected: string[];
}

function mount(props: {
  entry?: FileEntry;
  listing?: FolderListing;
  canSetVisibility?: boolean;
}): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  const selected: string[] = [];
  act(() => {
    root.render(
      createElement(FolderView, {
        entry: props.entry ?? entry(),
        listing: props.listing,
        canSetVisibility: props.canSetVisibility ?? true,
        contextLabel: "@seyi",
        onSelect: (path: string) => {
          selected.push(path);
        },
      }),
    );
  });

  return { container, selected };
}

describe("the folder's contents are the screen", () => {
  test("every entry is listed, named as the tree names it", () => {
    const view = mount({
      listing: listing([file("build-decisions.md"), file("findings.md")]),
    });
    expect(view.container.textContent).toContain("build-decisions");
    expect(view.container.textContent).toContain("findings");
    /*
      **Without the extension**, which is the same rule `displayName` applies in
      the tree. The listing used to print `README.md` on a screen whose sidebar
      printed `README` two inches away — one file, two names.
    */
    expect(view.container.textContent).not.toContain(".md");
  });

  test("a subfolder is marked as one, by a chevron rather than by punctuation", () => {
    const view = mount({
      listing: listing([
        { ...file("notes"), kind: "folder", path: `${FOLDER}/notes`, name: "notes" },
      ]),
    });
    expect(view.container.textContent).toContain("notes");
    // A trailing `/` is not how the tree says "folder" and is not how this
    // says it either — a folder is shown by the chevron in its gutter.
    expect(view.container.textContent).not.toContain("notes/");
    // The accessible name still says it, for anybody who cannot see the mark.
    expect(view.container.querySelector('[aria-label="notes, folder"]')).not.toBeNull();
  });

  /**
   * The reason this screen exists at all on a phone, and the reason is stronger
   * than the one that used to be written here.
   *
   * It read "the tree is a drawer, and a folder that cannot be opened into is a
   * folder whose notes are three taps and a gesture away". There is no drawer
   * and no tree at this density (`features/app/frame.ts`), so a folder that
   * cannot be opened into is a folder whose notes are **unreachable**: this row
   * and the note's path bar are the whole of walking a bucket on a phone.
   */
  test("a row opens what it names", () => {
    const view = mount({ listing: listing([file("build-decisions.md")]) });
    const row = view.container.querySelector('[aria-label="build-decisions"]');
    expect(row).not.toBeNull();
    act(() => {
      (row as HTMLElement).click();
    });
    expect(view.selected).toEqual([`${FOLDER}/build-decisions.md`]);
  });

  /**
   * The tree marks **only exceptions**, and so does this: drawing a folder's
   * default beside every one of its files buries the single note that differs
   * from it.
   */
  test("only an exception is marked", () => {
    const view = mount({
      listing: listing([
        file("ordinary.md"),
        file("held-back.md", { visibility: "private", exception: true }),
      ]),
    });
    /*
      The mark is a pip now rather than the word `team` or `private`, for the
      reason the tree gives: on a bucket laid out the standard way the word was
      the same eight times, which is the folder's default drawn once per file.
      So this counts marks, not words — scoped to the rows, because the
      visibility button's own label contains "private" and counting text across
      the screen counted the control.
    */
    const marked = [...view.container.querySelectorAll('[data-testid="folder-row"]')]
      .filter((row) => row.querySelector('[data-testid="folder-row-exception"]') !== null)
      .map((row) => row.getAttribute("aria-label"));
    expect(marked).toEqual(["held-back"]);

    // …and the ordinary row carries no marker at all. Without this the
    // assertion above passes when *every* row is marked, because the one it
    // names is still among them — which is what a sabotage of the `exception`
    // check proved.
    const ordinary = [...view.container.querySelectorAll('[data-testid="folder-row"]')].find(
      (row) => row.getAttribute("aria-label") === "ordinary",
    );
    expect(ordinary?.textContent).toBe("ordinary");
  });

  test("a short listing says so rather than reading as complete", () => {
    const view = mount({
      listing: listing([file("a.md")], { truncated: true }),
    });
    expect(view.container.textContent).toContain("more in it than is shown");
  });

  test("loading is not emptiness", () => {
    // A folder whose listing has not arrived must not be reported as empty —
    // the same "absent is not zero" rule the note count follows.
    const view = mount({ listing: undefined });
    expect(view.container.textContent).toContain("Loading");
    expect(view.container.textContent).not.toContain("nothing in it");
  });
});

describe("what an empty folder is told", () => {
  /**
   * THE test. The listing is filtered by the server at the caller's scope, so a
   * member looking at a folder of private notes sees zero rows — and telling
   * them "this folder has nothing in it" is a false statement about somebody
   * else's context, of exactly the kind the visibility rules exist to avoid.
   */
  test("a member sees 'nothing shared with you', not 'nothing here'", () => {
    const view = mount({ listing: listing([]), canSetVisibility: false });
    expect(view.container.textContent).toContain("Nothing in this folder is shared with you");
    expect(view.container.textContent).not.toContain("nothing in it yet");
  });

  test("the owner, who can see everything, is told it is empty", () => {
    const view = mount({ listing: listing([]), canSetVisibility: true });
    expect(view.container.textContent).toContain("nothing in it yet");
  });
});

describe("the folder's placeholder", () => {
  /**
   * The `README.md` a folder is made of is plumbing, not a note, and this page
   * is the surface it was loudest on: the first row of every folder, before
   * anything anybody wrote.
   *
   * It is dropped here by `listedEntries`, which the tree uses too — one filter,
   * so a file cannot be a row on one surface and absent on the other. See
   * `fileEditor.test.ts` for the rule itself.
   *
   * SABOTAGE: listing `listing.entries` directly again fails both tests here.
   */
  test("is not one of the rows", () => {
    const view = mount({
      listing: listing([file("README.md"), file("findings.md")]),
    });
    expect(view.container.textContent).toContain("findings");
    expect(view.container.textContent).not.toContain("README");
  });

  test("a folder holding nothing else is empty, and the sentence is the owner's", () => {
    const view = mount({ listing: listing([file("README.md")]), canSetVisibility: true });
    expect(view.container.textContent).toContain("nothing in it yet");
  });

  /**
   * The empty sentence still forks on who is asking. A member whose every note
   * in this folder is private, plus a placeholder, must not be told the folder
   * is empty — that is the claim this file exists to prevent, and the new filter
   * must not become a way to make it.
   */
  test("a member is still told what they are not being shown", () => {
    const view = mount({ listing: listing([file("README.md")]), canSetVisibility: false });
    expect(view.container.textContent).toContain("Nothing in this folder is shared with you");
  });
});

describe("the controls", () => {
  /**
   * **This pane draws neither of them any more, and that is the change.**
   *
   * A "Share…" pill in the heading and a full-width "Make this folder private"
   * beneath it were the first two things on a folder screen — the same two
   * capabilities a *note* offers, through a different pair of controls, in a
   * different place. They are one pair now: a lock and a share, drawn by the
   * frame's trailing group on a phone and by `BrowsePane`'s note head on a
   * pointer, for a folder and a note alike.
   *
   * Asserted as absence rather than deleted, because "the button is gone" and
   * "the button silently stopped rendering" look identical in a passing suite,
   * and this is the file somebody would edit to bring it back.
   */
  test("no share button of its own", () => {
    const view = mount({ listing: listing([]) });
    expect(view.container.querySelector('[data-testid="folder-share"]')).toBeNull();
  });

  test("no visibility button of its own, in either direction", () => {
    expect(mount({ listing: listing([]) }).container.textContent).not.toContain(
      "Make this folder private",
    );
    expect(
      mount({ entry: entry({ visibility: "private" }), listing: listing([]) }).container
        .textContent,
    ).not.toContain("Share this folder with your team");
  });

  test("…and still says what the folder's visibility is", () => {
    // The sentence stays where the buttons did not: it says what `team` means
    // for the notes inside this folder, which is the one thing a padlock
    // cannot.
    const view = mount({ listing: listing([]), canSetVisibility: false });
    expect(view.container.textContent).toContain("team —");
  });

  /**
   * The footnote is gone, and that is deliberate rather than an omission.
   *
   * "team means named people you granted access to. There is no public tier"
   * is an explanation of the model, and it was printed under every folder
   * listing in the console. It belongs where somebody has gone looking for it —
   * once — not forty times. What stays here is the line that says what is true
   * of *this* folder.
   */
  test("the folder states its own visibility and does not restate the model", () => {
    const text = mount({ listing: listing([]) }).container.textContent ?? "";
    expect(text).toContain("team —");
    expect(text).not.toContain("There is no public tier");
  });
});

describe("a folder is a page in the note's own column", () => {
  /**
   * REPORTED FROM A DESKTOP WINDOW, WITH A SCREENSHOT OF EACH: a note is a
   * centred column of prose and a folder listing was a column of rows pinned
   * to the left edge of a 900pt pane, with the rest of the pane empty. Two
   * pages in the same frame, laid out by two different rules — and the folder's
   * was the one with no argument behind it, since `readingMeasureEm` exists
   * precisely so a line of text does not run the width of the glass.
   *
   * The fix is the column, not a number: `FolderView` reads the same
   * `noteColumnWidth` the editor cuts its measure from.
   */
  test("the listing is held to the measure and centred in what is left", () => {
    const view = mount({ listing: listing([file("findings.md")]) });
    const column = view.container.querySelector('[data-testid="folder-column"]');
    expect(column).not.toBeNull();
    const style = getComputedStyle(column!);
    expect(Number.parseFloat(style.maxWidth)).toBe(noteColumnWidth);
    expect(style.alignSelf).toBe("center");
  });

  /**
   * THE property, and the reason the width is imported rather than written:
   * a centred column of `noteColumnWidth` starts at exactly the character the
   * note's first line starts at. The breadcrumb over both pages is indented to
   * `noteGutterFor`, so a folder name that did not land on the same sum would
   * sit visibly off the path above it.
   *
   * Both halves are asserted, because the constant can drift from the column
   * it is supposed to name in two different directions:
   *
   *  - It is the measure the **editor** cuts, which `LiveEditor.web.tsx`
   *    spends as `readingMeasureEm` em of the note's own `noteFontSize`. A
   *    `noteColumnWidth` that stopped being that product would centre the
   *    folder on a column no note has.
   *  - It is the measure **`noteGutterFor`** centres, which is what everything
   *    drawn above a page lines up with.
   *
   * SABOTAGE: give either one a number of its own — 620, say, which is what
   * `BrowsePane` carried as a dead style — and one of these two fails.
   */
  test("its first character is the note's first character", () => {
    // The editor's own measure, multiplied out exactly as the CSS does.
    expect(noteColumnWidth).toBe(layout.readingMeasureEm * layout.noteFontSize);
    for (const width of [900, 1024, 1440]) {
      // What the column's own left edge works out to: the document box centres
      // it, so half of what the measure did not use sits either side.
      const centred = (width - layout.notePadX * 2 - noteColumnWidth) / 2;
      expect(layout.notePadX + centred).toBe(noteGutterFor(width));
    }
  });

  /**
   * The `maxWidth` must not become a phone's layout. A 390pt screen is far
   * narrower than the measure, so the cap cannot bind there and the reading
   * margin goes on governing — the same floor the editor's `max(0, …)` has.
   */
  test("it cannot bind on a phone, where the margin governs", () => {
    expect(noteColumnWidth).toBeGreaterThan(390);
    expect(noteGutterFor(390)).toBe(layout.notePadX);
  });
});
