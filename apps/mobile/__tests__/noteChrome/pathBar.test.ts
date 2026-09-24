/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { dataWith, emptyEditor, layout, mountConsole, SHORT_FILE } from "./fixtures";

/**
 * **The phone's path bar**, which is the reversal of a stated decision.
 *
 * The breadcrumb was dropped on a phone because the note names itself inside
 * the document — right about *naming*, wrong about *navigation*. A folder page
 * reached by a link had no route to its parent at all, and the only way to
 * another folder was the drawer, which is the surface a phone makes hardest to
 * get at. `pathOnly` is the half that navigates and none of the half that
 * labelled: no visibility chip, and the context drawn as the pill in front of
 * the row rather than as a caption. The **leaf is drawn** — see the reversal
 * recorded on `an inline title` above, and `crumbs.ts` for the argument.
 *
 * Every assertion here is about *pressing* rather than about text. A path you
 * can only read is a label, and a label would satisfy a test that looked for
 * the words.
 */
describe("the path bar", () => {
  const DEEP = "3-resources/books/the-lean-startup.md";

  test("every ancestor is a target, and the note is the last segment", () => {
    const app = mountConsole(
      dataWith(
        { editor: { ...emptyEditor, status: "clean", path: DEEP, baseline: SHORT_FILE, draft: SHORT_FILE } } as never,
        { path: DEEP, name: "the-lean-startup.md" },
      ),
    );

    expect(app.find2("Open 3-resources")).not.toBeNull();
    expect(app.find2("Open 3-resources/books")).not.toBeNull();
    /*
      The leaf is drawn and is not a target. Both halves matter: without the
      first the line names the folder above the note somebody has open — which
      is the screenshot this was rebuilt from — and without the second there is
      a control whose press re-selects what is already selected.

      What it says is what the note **calls itself** — `noteHeading`, the same
      rung ladder the inline title uses — because a captured note's filename is
      a content hash and a crumb ending in one names nothing.
    */
    expect(app.find("breadcrumb-leaf")!.textContent).toBe("Notes");
    expect(app.find2(`Open ${DEEP}`)).toBeNull();
  });

  test("a note at the root is a segment, not an empty row", () => {
    /*
      The second screenshot: `@public-worship` lit, nothing after it, and the
      open note is that context's `index.md`. Every context has one and it is
      the first thing anybody opens, so "no ancestors, draw nothing" was not an
      edge case — it was the front page.

      SABOTAGE: restored `if (folders.length === 0) return null`. Fails here.
    */
    const app = mountConsole(
      dataWith(
        // A note with nothing to call itself, so the leaf falls back to the
        // filename — and drops the `.md`, which is filing rather than a name.
        {
          editor: { ...emptyEditor, status: "clean", path: "index.md", baseline: "", draft: "" },
        } as never,
        { path: "index.md", name: "index.md" },
      ),
    );
    expect(app.find("breadcrumb-leaf")!.textContent).toBe("index");
  });

  /**
   * **The reversal this branch is for.** Four real folder names beside
   * `FILE`'s sentence-length title run well past 390pt — the exact fixture
   * that used to fold `a`, `a/b` and `a/b/c` into a `…` and keep only `a/b/c/d`
   * live. There is no elision to fall back to any more: `NavBand`'s row
   * scrolls, so every ancestor stays its own pressable segment and the row
   * simply runs long instead of hiding one.
   *
   * SABOTAGE: restored `crumbsFor`'s old `maxFolders`/cap branch. Fails here —
   * `a`, `a/b` and `a/b/c` would go missing and `breadcrumb-gap` would exist.
   */
  test("a deep path renders every segment, in order, with no gap crumb", () => {
    const deep = "a/b/c/d/the-lean-startup.md";
    const app = mountConsole(dataWith({}, { path: deep, name: "the-lean-startup.md" }));

    expect(app.find("breadcrumb-gap")).toBeNull();
    for (const folder of ["a", "a/b", "a/b/c", "a/b/c/d"]) {
      expect(app.find2(`Open ${folder}`)).not.toBeNull();
    }
    expect(app.find("breadcrumb-leaf")!.textContent).toBe("The storage binding");
  });

  /**
   * A path you can only read is a label — every folder segment in that longer
   * row still has to be a real target, not only a visible one.
   */
  test("pressing any segment navigates to that folder", () => {
    const select = jest.fn(() => true);
    const deep = "a/b/c/d/the-lean-startup.md";
    const app = mountConsole(dataWith({ select }, { path: deep, name: "the-lean-startup.md" }));

    app.press(app.find2("Open a/b/c"));
    expect(select).toHaveBeenCalledWith("a/b/c");
  });

  /**
   * **Every folder segment is a real 44pt target**, checked against the box a
   * browser actually hit-tests rather than a constant fed to a prop that never
   * reaches it.
   *
   * This used to be `hitSlop`, asserted in `breadcrumbPath.test.ts` by holding
   * the exact object passed to it — the only thing a jsdom test *could* hold,
   * because react-native-web's `View` drops `hitSlop` from what it forwards to
   * the DOM before any hit-testing happens. Measured live in a real Chromium
   * build of this page: pressing a few pixels above a segment's visible box
   * landed on the row's plain container, never the segment, all the way to the
   * box's own edge — the slop bought nothing there. `minHeight` is a real
   * layout property instead, so it is what both platforms actually hit-test
   * against, and — because it is real — a rendered assertion can finally see
   * it, here, rather than re-deriving a number `Breadcrumb.tsx` already owns.
   *
   * SABOTAGE: `segment`'s `minHeight: layout.minTouchTarget` dropped in
   * `Breadcrumb.tsx`. Fails here.
   */
  test("every folder segment is a real 44pt target, not just a visible one", () => {
    const deep = "a/b/c/d/the-lean-startup.md";
    const app = mountConsole(dataWith({}, { path: deep, name: "the-lean-startup.md" }));

    const segment = app.find("breadcrumb-folder-a/b/c");
    expect(segment).not.toBeNull();
    const minHeight = Number.parseFloat(getComputedStyle(segment!).minHeight);
    expect(minHeight).toBeGreaterThanOrEqual(layout.minTouchTarget);
  });

  test("the context is a button at the head of the path, not a segment", () => {
    /*
      It was a monospace segment, pressable, and the argument for it was that a
      top-level folder has no ancestors so the bar would otherwise bottom out
      one level short of home. That argument survives; what changed is what
      carries it.

      Deleting the segment — the first attempt — took the way up with it, and a
      top-level folder was left with an empty path row and no route to its own
      root. The context is *moved* now: off the strip, onto the head of this
      row, as the same pill the strip draws, whose press opens the root.
    */
    const app = mountConsole(dataWith({}, { kind: "folder", path: "3-resources", name: "3-resources" }));
    // Not a monospace segment...
    expect(app.find2("Open @seyi")).toBeNull();
    // ...a button, and the only place `@seyi` is named.
    const pill = app.find("nav-context-seyi");
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute("role")).toBe("button");
    expect(app.find("context-strip-seyi")).toBeNull();
  });

  test("pressing a segment selects that folder", () => {
    const chosen: string[] = [];
    const app = mountConsole(
      dataWith(
        {
          select: (path: string) => chosen.push(path),
          editor: { ...emptyEditor, status: "clean", path: DEEP, baseline: SHORT_FILE, draft: SHORT_FILE },
        } as never,
        { path: DEEP, name: "the-lean-startup.md" },
      ),
    );

    app.press(app.find2("Open 3-resources/books"));
    expect(chosen).toEqual(["3-resources/books"]);
  });

  test("the path scrolls rather than wrapping or truncating", () => {
    /*
      `3-resources/books/reading-notes/…` is wider than a phone within three
      segments. Same rule as the contexts above it: nothing truncates, the row
      gets longer, the scroll absorbs it.

      The scroller is `NavBand`'s rather than the breadcrumb's own, because the
      context button scrolls *with* these segments — they are one line, and a
      button that stayed still while its path slid out from under it is two
      controls pretending to be one.
    */
    const app = mountConsole(
      dataWith(
        { editor: { ...emptyEditor, status: "clean", path: DEEP, baseline: SHORT_FILE, draft: SHORT_FILE } } as never,
        { path: DEEP, name: "the-lean-startup.md" },
      ),
    );
    const row = app.find("nav-band-trail");
    expect(row).not.toBeNull();
    expect(getComputedStyle(row!).flexDirection).not.toBe("column");
    // The button and the first segment are both inside it.
    expect(row!.contains(app.find("nav-context-seyi")!)).toBe(true);
    expect(row!.contains(app.find2("Open 3-resources")!)).toBe(true);
  });

  test("a switch draws no path until the browser is on the new context", () => {
    /*
      **The stale half of "the breadcrumb must reflect the restored place, not
      a stale one".**

      Pressing another context moves the URL first; the console selects it a
      commit later and the file browser resets a commit after that. Everything
      else in this pane is drawn from the browser's own state and stays
      internally consistent for those commits — the breadcrumb does not, because
      the pill at its head comes from the *console's* selection and moves with
      the URL.

      So without the guard the band reads `@supa / 3-resources / a-note-in-seyi`:
      one context's pill over another context's path, a sentence that has never
      been true, and the one the owner would read as "it persists where it last
      was". The pill alone is honest and is where the switch is going.

      SABOTAGE: dropped the `settled` guard in `BrowsePane`. Fails here.
    */
    const data = dataWith({ contextId: "w2" } as never, {
      path: DEEP,
      name: "the-lean-startup.md",
    });
    const app = mountConsole(data);

    // The pill is drawn — that is where the switch is going, and it is the way
    // up while the listing is on its way.
    expect(app.find("nav-context-seyi")).not.toBeNull();
    // …and none of the previous context's path is.
    expect(app.find("breadcrumb-leaf")).toBeNull();
    expect(app.find2("Open 3-resources")).toBeNull();
  });

  test("a pointer layout keeps the full line instead, chip and all", () => {
    // The positive control for the whole shape: `pathOnly` must not be what a
    // desktop gets, or the visibility chip and the leaf disappear from the one
    // density that has room for them.
    const app = mountConsole(dataWith({}, { path: DEEP, name: "the-lean-startup.md" }), 1200);
    expect(app.find2(`Open ${DEEP}`)).toBeNull();
    expect(app.find2("Open 3-resources")).not.toBeNull();
    expect(app.container.textContent).toContain("the-lean-startup");
  });

  /**
   * **The pointer breadcrumb's own row does not grow to the touch floor.**
   *
   * `layout.minTouchTarget` is right for `NavBand`'s row because that row is
   * already 44 tall — `CurrentContextPill`'s own target holds it there — so a
   * folder segment growing to match costs nothing visible. The pointer bar
   * makes no such claim: its row is a plain 22.15pt line, and a folder segment
   * that grew to 44 there would grow the *row*, not just the target — a real,
   * visible regression on a surface a mouse, not a thumb, presses.
   *
   * SABOTAGE: `minHeight: layout.minTouchTarget` moved from `segmentTouch`
   * back onto `segment` itself in `Breadcrumb.tsx` — the shape an earlier,
   * broader version of this fix took. Fails here: the pointer segment's
   * `minHeight` reads 44 instead of the unset value this asserts against.
   */
  test("a pointer layout's folder segment stays its own height, not the touch floor", () => {
    const app = mountConsole(dataWith({}, { path: DEEP, name: "the-lean-startup.md" }), 1200);
    const segment = app.find("breadcrumb-folder-3-resources");
    expect(segment).not.toBeNull();
    const minHeight = Number.parseFloat(getComputedStyle(segment!).minHeight || "0");
    expect(minHeight).toBeLessThan(layout.minTouchTarget);
  });

  test("and a pointer layout mid-switch draws neither the line nor the note's actions", () => {
    /*
      The same seam as the phone's, and it is worth its own case because the
      pointer layout's header carries more than a path: its leading segment is
      `contextLabel`, which comes from the **console**, over folders that come
      from the **browser**, and beside them Share and the scope lock, which act
      on the open note.

      For the commits after pressing another context those two disagree — so
      the line would name one context over another context's path, and the
      buttons beside it would offer to share a note from the context being
      left. Both go together, which is right rather than incidental.

      SABOTAGE: dropped `settled` from the pointer branch in `BrowsePane`.
      Fails here.
    */
    const app = mountConsole(
      dataWith({ contextId: "w2" } as never, { path: DEEP, name: "the-lean-startup.md" }),
      1200,
    );
    expect(app.find2("Open 3-resources")).toBeNull();
    expect(app.find("browse-share")).toBeNull();
  });
});
