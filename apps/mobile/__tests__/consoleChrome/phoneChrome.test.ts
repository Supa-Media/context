/**
 * @jest-environment jsdom
 */

/**
 * On a phone: the navigation strip and bottom row that replaced the drawer
 * panels, the toolbar as the only gesture-free route to the commands, the
 * navigation landmark, and the top row's account-and-capsule layout.
 *
 * Split out of `consoleChrome.test.ts`; see `fixtures.ts` in this folder for
 * the module-level rationale and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
import { mountConsole } from "./fixtures";

describe("on a phone", () => {
  /**
   * **This used to be `the tree is a drawer, and the toolbar replaces the
   * status bar`**, and it asserted a `frame-drawer-toggle`. A phone has no left
   * panel at all now — no file-tree drawer, no rail sheet, no toggle for either
   * and no scrim from either (`features/app/frame.ts`) — so that assertion
   * describes a design that was removed and is replaced rather than deleted.
   *
   * It is replaced **positively**, which is the part that matters. "There is no
   * drawer toggle" is also what a phone renders when its whole top row has
   * failed to mount, so a rewrite that only checked the old things were absent
   * would pass on a broken screen. The two surfaces navigation actually moved
   * to are asserted present, and only then is the retired chrome asserted gone.
   *
   * **And the strip along the top went too** (owner, 2026-09-27, the phone
   * artboards, screen 9): switching workspaces is the account sheet's now, so
   * the top of a phone is the path row with the context you are in at its
   * head. The bottom is Apple Notes' bar since 2026-09-30: a search field and
   * the round new-note button.
   */
  test("navigation is the path along the top and a row along the bottom", () => {
    const app = mountConsole(390);

    // The things that replaced the panels.
    expect(app.find("nav-band")).not.toBeNull();
    expect(app.find("context-strip")).toBeNull();
    expect(app.find("notes-bar")).not.toBeNull();
    /*
      The round button: a note at once, and held, the sheet with everything
      else a `+` starts — a drawing, a folder, a meeting.
    */
    expect(app.find("notes-bar-compose")).not.toBeNull();
    // And the five keys it replaced are gone.
    for (const key of ["back", "browse", "new", "recent", "meeting", "separator"]) {
      expect(app.find(`bottom-bar-${key}`)).toBeNull();
    }
    // And the account, pinned at the leading end of the top row.
    expect(app.find("account-menu")).not.toBeNull();

    // The bottom edge is one of the two, never both — `frame.ts`'s invariant.
    expect(app.find("console-status")).toBeNull();

    // Nothing of the left panel: not the tree, not a drawer, not a rail sheet,
    // not a scrim, and no toggle for any of them.
    for (const gone of [
      "explorer-tree",
      "frame-drawer",
      "frame-drawer-toggle",
      "frame-nav-sheet",
      "frame-nav-toggle",
      "frame-scrim",
    ]) {
      expect(app.find(gone)).toBeNull();
    }

    app.unmount();
  });

  test("the toolbar is the only route to the commands with no gesture", () => {
    // There is no keyboard here and no right-click. Creating and searching are
    // not things you do *to* an existing note, so the row's long-press menu
    // cannot reach them — this bar is it.
    const app = mountConsole(390);

    // Labels, not glyphs: the glyphs are aria-hidden, so what a screen reader
    // gets is the whole affordance.
    const labels = Array.from(app.container.querySelectorAll("[aria-label]")).map((node) =>
      node.getAttribute("aria-label"),
    );
    expect(labels).toContain("Search notes");
    /*
      "New note": the round button makes one at once, in the folder on screen
      or, from Home, in the Inbox. Held, it raises the sheet with a drawing, a
      folder and a meeting (`CreatePrompt`), which its hint says.
    */
    expect(labels).toContain("New note");
    // The bar is really on the screen, and not merely a set of labels somewhere
    // in the tree. It used to be enough to assert the console had rendered
    // *any* text — and then it was not, because the top bar became a toggle and
    // one group of icons with nothing in the middle. The middle has words again
    // (the context strip), so a text sweep would pass on a screen with no
    // toolbar at all; the testID is what makes this about the bar.
    expect(app.find("notes-bar")).not.toBeNull();

    app.unmount();
  });

  /**
   * A phone can be navigated by landmark, and for a while it could not.
   *
   * `AppFrame` declares `role="navigation"` on exactly two things — the rail
   * column and the rail sheet — and **neither is rendered at compact**. When
   * the panels went, the assertion that a phone had a nav landmark went with
   * the sheet it was written about, and the two surfaces navigation actually
   * moved to declared nothing. A phone-width browser window therefore had zero
   * navigation landmarks: every pill and every key had a good `aria-label`, and
   * a screen-reader user rotoring by landmark, or anything jumping to `<nav>`,
   * could not find the navigation at all. Labelling each control is not the
   * same capability as being able to find the group of them.
   *
   * So this counts them at the console level rather than trusting a component:
   * exactly one. It was the workspace strip; since the strip went into the
   * account sheet (2026-09-27) it is the path row, `NavBand`, which is the
   * navigation left on the glass. The bottom row is deliberately **not** a
   * second one — six of its seven keys are verbs about the open note, and
   * calling a row of verbs "navigation" because one destination sits at the end
   * behind a separator makes the landmark mean less rather than more — so it is
   * asserted to still be the toolbar it says it is.
   *
   * SABOTAGE: dropped `role`/`aria-label` from `NavBand`'s root. Fails here.
   */
  test("a phone has a navigation landmark, and it is not the toolbar", () => {
    const app = mountConsole(390);

    const landmarks = Array.from(app.container.querySelectorAll("nav"));
    expect(landmarks).toHaveLength(1);
    expect(landmarks[0]!.dataset.testid).toBe("nav-band");
    expect(landmarks[0]!.getAttribute("aria-label")).toBe("Path");

    // The bottom row stays a toolbar, named, and is not a second landmark.
    const bar = app.find("notes-bar")!;
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.getAttribute("aria-label")).toBe("Search and new note");
    expect(bar.closest("nav")).toBeNull();

    app.unmount();
  });

  test("the top row is an account and a capsule, and the path is below it", () => {
    /*
      The two-rows-of-chrome complaint, at the console level.
      `appFrameRender.test.ts` pins the frame's own geometry; this pins what the
      console hands it.

      **This asserted three slots — an account, the contexts, a capsule — and
      the middle one has moved.** A floating top bar means the document runs
      behind whatever is in it, which the note's own verbs earn and navigation
      does not: a row of context pills lay across somebody's note at every
      scroll position, and named the context a second time one line above a
      breadcrumb that already did. The contexts are the first row of `NavBand`
      now, inside the scroller. One row of chrome is still one row; what is in
      it is smaller.
    */
    const app = mountConsole(390);

    // Leading: the account. Trailing: the capsule with the note's own actions,
    // which is `noteChrome.test.ts`'s.
    expect(app.find("account-menu")).not.toBeNull();

    // The path is on the screen, and not in the bar: the band is inside the
    // pane, and the workspace strip that used to lead it is gone — switching
    // is the account sheet's now (2026-09-27).
    const band = app.find("nav-band");
    expect(band).not.toBeNull();
    expect(app.find("context-strip")).toBeNull();
    expect(band!.closest('[data-testid="app-frame"] > div')).not.toBe(
      app.find("account-menu")!.closest('[data-testid="app-frame"] > div'),
    );

    // The two controls that used to be here, and the chip that never was.
    expect(app.find("frame-drawer-toggle")).toBeNull();
    expect(app.find("frame-nav-toggle")).toBeNull();
    expect(app.find("storage-pill")).toBeNull();

    app.unmount();
  });
});
