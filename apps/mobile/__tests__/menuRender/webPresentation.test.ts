/**
 * @jest-environment jsdom
 */

/**
 * The web build picks its presentation on the window, not the bundle — the
 * same `Menu.web` module serves both a phone-width sheet and a desktop-width
 * popover — and Cancel stays centred on both.
 *
 * Split out of `menuRender.test.ts`; see `fixtures.ts` in this folder for the
 * module-level rationale and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { DESKTOP, PHONE, darkColors, layout, mountSheet, mountWeb, mounted, styleOf } from "./fixtures";

describe("the web build picks its presentation on the window, not the bundle", () => {
  /**
   * The bug this section exists for.
   *
   * `Menu.tsx`'s sheet is reachable only from a native build, and this product
   * reaches phones as a **web** build. So for the whole of this branch a long
   * press on a phone browser — which does raise `contextmenu`, correctly — opened
   * the 28px pointer popover: the exact mis-tap beside "Delete forever…" that the
   * sheet was written to prevent. `Explorer` was already passing
   * `platform: "touch"` at that width, so the *items* were right and only the
   * chrome was wrong, which is the kind of half-correct that survives review.
   *
   * The rule is `Palette`'s, deliberately: native is always the sheet (module
   * resolution decides that), and the browser asks the window.
   */
  test("a phone-width viewport gets the sheet, not the popover", () => {
    const menu = mountWeb(PHONE, "touch");

    expect(menu.find("menu-sheet")).not.toBeNull();
    expect(menu.find("menu-root")).toBeNull();
    // The visible way out, on a sheet whose last row is destructive.
    expect(menu.find("menu-item-cancel")).not.toBeNull();
    expect(menu.find("menu-title")?.textContent).toBe("plan.md");
  });

  test("its rows are thumb targets — 44pt, from the web bundle", () => {
    const menu = mountWeb(PHONE, "touch");

    // The row that must not be mis-tapped, and the one directly under it.
    expect(styleOf(menu.find("menu-item-delete")!, "min-height")).toBe("44px");
    expect(styleOf(menu.find("menu-item-cancel")!, "min-height")).toBe("44px");
    // And nothing is pinned to the pointer height that caused this.
    expect(styleOf(menu.find("menu-item-delete")!, "height")).not.toBe("28px");
  });

  test("a desktop-width viewport gets the compact popover, with its chords", () => {
    const menu = mountWeb(DESKTOP, "web");

    expect(menu.find("menu-root")).not.toBeNull();
    expect(menu.find("menu-sheet")).toBeNull();
    expect(styleOf(menu.find("menu-item-delete")!, "height")).toBe("28px");
    expect(menu.text()).toContain("⌘D");
  });

  test("the switch is the layout token, not a number typed into the component", () => {
    const narrow = mountWeb({ width: layout.narrowBreakpoint - 1, height: 844 }, "touch");
    expect(narrow.find("menu-sheet")).not.toBeNull();
    while (mounted.length > 0) mounted.pop()?.();

    const wide = mountWeb({ width: layout.narrowBreakpoint, height: 844 }, "web");
    expect(wide.find("menu-root")).not.toBeNull();
  });

  /**
   * `menu.ts` omits `shortcut` at compact density, so normally there is nothing
   * to draw. This is the other end of that promise: handed the *pointer* list
   * at a phone width — which is what a mismatch between the two breakpoints
   * would produce — the sheet still prints no chord, because a column of chords
   * nobody can type costs a fifth of the width of a phone.
   */
  test("the sheet prints no chords even when handed some", () => {
    const menu = mountWeb(PHONE, "web");

    expect(menu.find("menu-sheet")).not.toBeNull();
    for (const glyph of ["⌘", "⇧", "⌫", "Ctrl+"]) expect(menu.text()).not.toContain(glyph);
  });

  /**
   * A submenu on a phone is a second page, not a popover hanging off the side
   * of another popover: there is nowhere to hang one and no hover to open it.
   */
  test("a submenu on the sheet pushes a page rather than a second panel", () => {
    const menu = mountWeb(PHONE, "touch");

    const parent = menu.find("menu-item-visibility");
    expect(parent).not.toBeNull();
    act(() => {
      parent!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      parent!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      parent!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(menu.find("menu-sub")).toBeNull();
    expect(menu.find("menu-item-back")).not.toBeNull();
    expect(menu.labels()).toEqual([
      "Visibility",
      "Make private",
      "Share with the team",
      "Use the folder's setting",
      "Cancel",
    ]);
  });

  /** The same danger promise the native sheet makes, from the web bundle. */
  test("a destructive row on the web sheet keeps the critical colour", () => {
    const menu = mountWeb(PHONE, "touch");
    const danger = menu.find("menu-label-delete");
    const ordinary = menu.find("menu-label-open");

    expect(styleOf(danger!, "color")).not.toBe(styleOf(ordinary!, "color"));
    expect(styleOf(danger!, "color").replace(/\s/g, "")).toBe(
      `rgb(${[1, 3, 5].map((at) => parseInt(darkColors.critText.slice(at, at + 2), 16)).join(",")})`,
    );
  });
});

describe("Cancel stays centred", () => {
  /*
    A regression this file did not catch, found by looking at the sheet.

    Stacking a `detail` under a label means wrapping the two in a column, and
    the obvious `flex: 1` on that column fills the row — at which point the
    row's `justifyContent: "center"` has nothing left to centre and Cancel
    silently left-aligns. It is the one row on this sheet that is centred on
    purpose, and both conditions have to hold, so both are asserted: the row
    centres, and nothing inside it grows to swallow the space it centres in.
  */
  test("on the native sheet", () => {
    const sheet = mountSheet();
    expect(styleOf(sheet.find("menu-item-cancel")!, "justify-content")).toBe("center");
    expect(styleOf(sheet.find("menu-labels-cancel")!, "flex-grow")).not.toBe("1");
  });

  test("and on the web sheet", () => {
    const menu = mountWeb(PHONE, "touch");
    expect(styleOf(menu.find("menu-item-cancel")!, "justify-content")).toBe("center");
    expect(styleOf(menu.find("menu-labels-cancel")!, "flex-grow")).not.toBe("1");
  });
});
