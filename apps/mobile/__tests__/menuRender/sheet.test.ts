/**
 * @jest-environment jsdom
 */

/**
 * The touch sheet (`Menu.tsx`): the rows it draws, choosing something on it,
 * its submenu as a second page, and Escape/back-button closing it.
 *
 * Split out of `menuRender.test.ts`; see `fixtures.ts` in this folder for the
 * module-level rationale and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { darkColors, mockInsets, mountSheet, sheetItems, styleOf } from "./fixtures";

describe("the sheet draws the menu it was given", () => {
  test("every item is a row, in the order the model put them in", () => {
    const sheet = mountSheet();
    const items = sheetItems();

    expect(sheet.labels()).toEqual([...items.map((item) => item.label), "Cancel"]);
    for (const item of items) expect(sheet.find(`menu-item-${item.id}`)).not.toBeNull();

    // The file name, so a sheet that slid up over a list says which row it is
    // about.
    expect(sheet.find("menu-title")?.textContent).toBe("plan.md");
  });

  /**
   * `menu.ts` omits `shortcut` entirely on touch. This is the other end of that:
   * nothing here puts a chord back on a device with no keyboard.
   */
  test("no chords are printed on a sheet", () => {
    // Mounted for its effect on the document — `Modal` portals into
    // `document.body`, which is where the assertion below reads from.
    mountSheet();
    const text = document.body.textContent ?? "";
    for (const glyph of ["⌘", "⇧", "⌫", "Ctrl+"]) expect(text).not.toContain(glyph);
  });

  test("a destructive row is coloured differently from an ordinary one", () => {
    const sheet = mountSheet();
    const danger = sheet.find("menu-label-delete");
    const ordinary = sheet.find("menu-label-open");
    expect(danger).not.toBeNull();
    expect(ordinary).not.toBeNull();

    const dangerColor = styleOf(danger!, "color");
    expect(dangerColor).not.toBe(styleOf(ordinary!, "color"));
    // …and it is the palette's critical colour, not merely "some other colour".
    expect(dangerColor.replace(/\s/g, "")).toBe(
      `rgb(${[1, 3, 5].map((at) => parseInt(darkColors.critText.slice(at, at + 2), 16)).join(",")})`,
    );
  });

  /** A thumb lands within about 10mm of where it is aimed. */
  test("a row is at least 44pt tall", () => {
    const sheet = mountSheet();
    expect(styleOf(sheet.find("menu-item-delete")!, "min-height")).toBe("44px");
    expect(styleOf(sheet.find("menu-item-cancel")!, "min-height")).toBe("44px");
  });

  /**
   * The home indicator sits over the bottom ~34pt of an iPhone's screen, and
   * the sheet is anchored to that edge — so the last row is the one that ends
   * up underneath it.
   */
  test("the bottom inset is left clear", () => {
    const sheet = mountSheet();
    const padding = Number.parseFloat(styleOf(sheet.find("menu-sheet")!, "padding-bottom"));
    expect(padding).toBeGreaterThanOrEqual(mockInsets.bottom);
  });

  /** A menu longer than the sheet scrolls rather than growing off the screen. */
  test("the list scrolls", () => {
    const sheet = mountSheet();
    // RNW expands the `overflow` shorthand, so the shorthand reads as "".
    expect(styleOf(sheet.find("menu-list")!, "overflow-y")).toMatch(/auto|scroll/);
  });
});

describe("choosing something", () => {
  test("a row selects its own id and closes the sheet", () => {
    const sheet = mountSheet();
    sheet.press("menu-item-archive");
    expect(sheet.selected).toEqual(["archive"]);
    expect(sheet.dismissals).toBe(1);
  });

  test("Cancel closes and chooses nothing", () => {
    const sheet = mountSheet();
    sheet.press("menu-item-cancel");
    expect(sheet.selected).toEqual([]);
    expect(sheet.dismissals).toBe(1);
  });

  test("the scrim closes and chooses nothing", () => {
    const sheet = mountSheet();
    const scrim = document.body.querySelector<HTMLElement>('[aria-label="Close menu"]');
    expect(scrim).not.toBeNull();
    act(() => {
      scrim!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      scrim!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      scrim!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sheet.selected).toEqual([]);
    expect(sheet.dismissals).toBeGreaterThanOrEqual(1);
  });
});

describe("a submenu is a second page, not a nested popover", () => {
  test("opening Visibility dispatches nothing and closes nothing", () => {
    const sheet = mountSheet();
    sheet.press("menu-item-visibility");

    // The failure this guards: a row that opens the page *and* fires. The id
    // has no handler, so on screen it would look correct.
    expect(sheet.selected).toEqual([]);
    expect(sheet.dismissals).toBe(0);
  });

  test("the page replaces the first one, with a way back", () => {
    const sheet = mountSheet();
    sheet.press("menu-item-visibility");

    expect(sheet.labels()).toEqual([
      "Visibility",
      "Make private",
      "Share with the team",
      "Use the folder's setting",
      "Cancel",
    ]);
    /*
      The back row *draws* the parent's name beside a chevron and is *named*
      "Back to Visibility". The chevron used to be spelled into the label
      string — `‹  Visibility` — which put a "single left-pointing angle
      quotation mark" into the accessible name, and dropping it without
      replacing it would leave a button announced identically to the item that
      opened it.
    */
    const back = sheet.find("menu-item-back")!;
    expect(back.getAttribute("aria-label")).toBe("Back to Visibility");
    expect(back.querySelector('[data-icon="chevronLeft"]')).not.toBeNull();

    // The first page is gone rather than layered underneath.
    expect(sheet.find("menu-item-delete")).toBeNull();

    sheet.press("menu-item-back");
    expect(sheet.find("menu-item-delete")).not.toBeNull();
    expect(sheet.selected).toEqual([]);
  });

  test("a child row selects the real id and closes", () => {
    const sheet = mountSheet();
    sheet.press("menu-item-visibility");
    sheet.press("menu-item-visibilityTeam");
    expect(sheet.selected).toEqual(["visibilityTeam"]);
    expect(sheet.dismissals).toBe(1);
  });
});

describe("asking to close", () => {
  /**
   * Escape and the Android back button are the same request as far as this
   * component is concerned: `Modal`'s `onRequestClose`. react-native-web raises
   * it from Escape, and it only arms that listener once the modal is *active* —
   * which, for an animated modal, is after the slide-in animation ends. jsdom
   * runs no animations, so the test has to say the animation finished.
   */
  test("Escape dismisses", () => {
    const sheet = mountSheet();

    // `Modal` portals into a fresh `div` under `document.body`; the element
    // carrying `onAnimationEnd` is that portal's only child.
    let portal: HTMLElement | null = sheet.find("menu-sheet");
    while (portal !== null && portal.parentElement !== document.body) {
      portal = portal.parentElement;
    }
    const animation = portal?.firstElementChild ?? null;
    expect(animation).not.toBeNull();

    act(() => {
      animation!.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    });

    expect(sheet.dismissals).toBeGreaterThanOrEqual(1);
    expect(sheet.selected).toEqual([]);
  });
});
