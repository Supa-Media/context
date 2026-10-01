/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
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
/**
 * **The phone's way up is ‹ back, and there is no path row any more.**
 *
 * The owner's review of the phone Home (2026-10-01): *"we should probably put
 * back buttons at the top left when people click into folders or notes"* and
 * *"I dont think we need to show the file path at the top of notes anymore"*.
 * The path row — the workspace's pill, then every folder — was the way up, and
 * it scrolled away with the page as a row of small targets. Now the top-left
 * slot is a back button on every page below Home, naming where it goes: a
 * note's folder, a folder's parent, and Home from the top of the workspace.
 *
 * Every assertion is about *pressing*: a back button that says the right word
 * and goes somewhere else is the bug this has to catch.
 *
 * SABOTAGE: `phoneBackTarget` taking the page's own path for its parent fails
 * the first four; `BrowsePathBar` drawing the old `NavBand` fails the third.
 */
describe("the phone's way up", () => {
  const DEEP = "3-resources/books/the-lean-startup.md";

  test("a note's back button names its folder and opens it", () => {
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
    const back = app.find("phone-back");
    expect(back).not.toBeNull();
    expect(back!.getAttribute("aria-label")).toBe("Back to books");
    app.press(back);
    expect(chosen).toEqual(["3-resources/books"]);
  });

  test("a folder's back button opens the folder it is in", () => {
    const chosen: string[] = [];
    const app = mountConsole(
      dataWith({ select: (path: string) => chosen.push(path) } as never, {
        kind: "folder",
        path: "3-resources/books",
        name: "books",
      }),
    );
    expect(app.find("phone-back")!.getAttribute("aria-label")).toBe("Back to resources");
    app.press(app.find("phone-back"));
    expect(chosen).toEqual(["3-resources"]);
  });

  test("the top of the workspace goes back to Home, and no path is drawn", () => {
    let home = 0;
    const app = mountConsole(
      dataWith(
        {
          deselect: () => {
            home += 1;
            return true;
          },
          editor: { ...emptyEditor, status: "clean", path: "index.md", baseline: "", draft: "" },
        } as never,
        { path: "index.md", name: "index.md" },
      ),
    );
    expect(app.find("phone-back")!.getAttribute("aria-label")).toBe("Back to Home");
    app.press(app.find("phone-back"));
    expect(home).toBe(1);
    // None of the old row: no workspace pill, no path, no leaf.
    expect(app.find("nav-band")).toBeNull();
    expect(app.find("nav-context-seyi")).toBeNull();
    expect(app.find("breadcrumb-leaf")).toBeNull();
  });

  test("a deep note draws no folder segments either", () => {
    const app = mountConsole(dataWith({}, { path: "a/b/c/d/the-lean-startup.md", name: "the-lean-startup.md" }));
    for (const folder of ["a", "a/b", "a/b/c", "a/b/c/d"]) expect(app.find2(`Open ${folder}`)).toBeNull();
    expect(app.find("phone-back")!.getAttribute("aria-label")).toBe("Back to d");
  });

  test("Home has no back button: its top-left is the workspace's own mark", () => {
    const app = mountConsole(dataWith({ selectedPath: null } as never));
    expect(app.find("phone-back")).toBeNull();
    const account = app.find("account-menu");
    expect(account).not.toBeNull();
    expect(account!.getAttribute("aria-label")).toBe("@seyi — workspaces and account");
  });

  test("the back button is a real 44pt target", () => {
    const app = mountConsole(dataWith({}, { path: DEEP, name: "the-lean-startup.md" }));
    const minHeight = Number.parseFloat(getComputedStyle(app.find("phone-back")!).minHeight);
    expect(minHeight).toBeGreaterThanOrEqual(layout.minTouchTarget);
  });
});

describe("the pointer path bar", () => {
  const DEEP = "3-resources/books/the-lean-startup.md";

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
