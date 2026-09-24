/**
 * @jest-environment jsdom
 */

/**
 * A detail line drawn under its label, a row that carries a checked state,
 * and a disabled row — present but inert to both the pointer and the
 * keyboard.
 *
 * Split out of `menuRender.test.ts`; see `fixtures.ts` in this folder for the
 * module-level rationale and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import {
  DESKTOP,
  type MenuItem,
  folderItems,
  itemsFor,
  mountPopover,
  mountSheet,
  mountWebWith,
  note,
  styleOf,
} from "./fixtures";

describe("a detail line is drawn under its label", () => {
  /**
   * The folder visibility pair is the only place in this menu that carries one,
   * and the sentence it carries is the reason somebody presses one row rather
   * than the other: `setFolderVisibility` sets the folder's default, and a note
   * with its own exception keeps it. A control that said "Share everything
   * here" and silently meant "except four notes" would be the console
   * overstating what it had just done to somebody's access.
   */
  function submenuOf(items: MenuItem[]): MenuItem[] {
    return items.find((item) => item.id === "visibility")?.items ?? [];
  }

  test("the sheet draws it", () => {
    const sheet = mountSheet(submenuOf(folderItems("touch")));
    expect(sheet.find("menu-detail-visibilityTeam")?.textContent).toBe(
      "Except notes with a setting of their own.",
    );
  });

  test("and a row with nothing to add draws nothing", () => {
    // Not vacuous in the other direction: a component that rendered the field
    // unconditionally would put an empty line under every row on the sheet.
    const sheet = mountSheet();
    expect(sheet.find("menu-detail-archive")).toBeNull();
  });

  test("the pointer popover draws it, at the height its geometry assumed", () => {
    /*
      The popover declares its own box size — `heightFor` — and that number is
      what the flip-above-the-pointer decision reads. A row rendered taller than
      it was measured is a menu that runs off the bottom of the window instead
      of flipping, which is exactly the failure the fixed 28px row height exists
      to prevent. So the tall row is a declared height too, not a `minHeight`.
    */
    const tall = mountWebWith(submenuOf(folderItems("web")), { width: 1280, height: 800 });
    expect(tall.find("menu-detail-visibilityTeam")).not.toBeNull();
    // 28 (`ROW_HEIGHT`) + 18 (`DETAIL_BLOCK`), the number `heightFor` adds.
    expect(styleOf(tall.find("menu-item-visibilityTeam")!, "height")).toBe("46px");

  });

  test("a popover row with no detail keeps the ordinary height", () => {
    // The control for the case above, in its own test because every query here
    // reads from `document.body` — `Modal` portals — so two menus mounted
    // together answer as one.
    const plain = mountWebWith(
      submenuOf(
        itemsFor({
          target: { kind: "row", row: note("1-projects/plan.md") },
          canEdit: true,
          canSetVisibility: true,
          canShare: true,
          canDownload: true,
          clipboard: null,
          platform: "web",
        }),
      ),
      { width: 1280, height: 800 },
    );
    expect(styleOf(plain.find("menu-item-visibilityTeam")!, "height")).toBe("28px");
  });
});

/* -------------------------------------------------------------------------- */
/*                      the setting in force, on the glass                    */
/* -------------------------------------------------------------------------- */

describe("a row that carries a state draws it, and says so", () => {
  /**
   * `menu.ts` decides which of the three visibility items is in force; this is
   * the half that puts it on screen. Both are needed and neither is enough: a
   * model that marks the right row and a sheet that draws no marks is a menu
   * that still makes you experiment on somebody's access to find out what it
   * is currently set to.
   *
   * The sheet is checked here rather than only the popover because it is the
   * **only** presentation on a phone. Left out, "which visibility is this note
   * actually on" would be a question the pointer layout answers and the phone
   * does not.
   */
  const VISIBILITY: MenuItem[] = [
    { id: "visibilityPrivate", label: "Make private", checked: false },
    { id: "visibilityTeam", label: "Share with the team", checked: false },
    {
      id: "visibilityFollow",
      label: "Use the folder's setting",
      checked: true,
      detail: "Currently team — from 1-projects.",
    },
  ];

  test("the row in force has a mark and the others have none", () => {
    const menu = mountSheet(VISIBILITY);
    expect(menu.find("menu-check-visibilityFollow")?.children.length).toBe(1);
    expect(menu.find("menu-check-visibilityPrivate")?.children.length).toBe(0);
    expect(menu.find("menu-check-visibilityTeam")?.children.length).toBe(0);
  });

  /**
   * `false` and `undefined` are different, and this is why: an unchecked row
   * still reserves the gutter, so the three labels start on one vertical line
   * and the list does not appear to re-order itself as the setting changes.
   */
  test("an unchecked row still reserves the gutter", () => {
    const menu = mountSheet(VISIBILITY);
    expect(menu.find("menu-check-visibilityPrivate")).not.toBeNull();
  });

  test("a row with no state draws no gutter at all", () => {
    const menu = mountSheet([{ id: "archive", label: "Archive" }]);
    expect(menu.find("menu-check-archive")).toBeNull();
  });

  /**
   * A screen reader announcing "Use the folder's setting" with no mention of
   * its being the one in force has given a blind reader strictly less than the
   * check gives everybody else — on the control that decides who can read a
   * note.
   */
  test("the state reaches the accessible tree, not only the glass", () => {
    const menu = mountSheet(VISIBILITY);
    const on = menu.find("menu-item-visibilityFollow");
    const off = menu.find("menu-item-visibilityPrivate");
    expect(on?.getAttribute("aria-checked")).toBe("true");
    expect(off?.getAttribute("aria-checked")).toBe("false");
    expect(on?.getAttribute("role")).toBe("menuitemradio");
  });

  test("and a row with no state is a plain menu item, with no checked claim", () => {
    const menu = mountSheet([{ id: "archive", label: "Archive" }]);
    const row = menu.find("menu-item-archive");
    expect(row?.getAttribute("aria-checked")).toBeNull();
    expect(row?.getAttribute("role")).not.toBe("menuitemradio");
  });

  /** The one line the submenu earns — what "the folder's setting" actually is. */
  test("the follow row carries the value it is following", () => {
    const menu = mountSheet(VISIBILITY);
    expect(menu.find("menu-detail-visibilityFollow")?.textContent).toBe(
      "Currently team — from 1-projects.",
    );
  });
});

describe("a disabled row is present, dimmed, and does not fire", () => {
  /**
   * The rule the file menu never uses and the tab menu's "Reopen closed" does.
   * Adding the field without drawing it would have shipped a row that looks
   * ordinary, invites a press and silently does nothing — worse than either
   * absence or a greyed row, because it is the only one of the three that
   * lies.
   */
  const ITEMS: MenuItem[] = [
    { id: "archive", label: "Archive" },
    { id: "restore", label: "Reopen closed", disabled: true },
  ];

  test("it is still in the list", () => {
    // The sheet appends its own Cancel row — see the top of this file.
    expect(mountSheet(ITEMS).labels()).toEqual(["Archive", "Reopen closed", "Cancel"]);
  });

  test("pressing it dispatches nothing", () => {
    const menu = mountSheet(ITEMS);
    menu.press("menu-item-restore");
    expect(menu.selected).toEqual([]);
  });

  test("while the row beside it still does", () => {
    const menu = mountSheet(ITEMS);
    menu.press("menu-item-archive");
    expect(menu.selected).toEqual(["archive"]);
  });
});

describe("a disabled row refuses the keyboard as well as the pointer", () => {
  /**
   * The bug this was written for: the popover's own arrow-key navigation
   * dispatches on Enter, and it did so without consulting `disabled`. So a row
   * that was dimmed, inert to a click and marked `aria-disabled` fired anyway
   * for anybody driving the menu from the keyboard — which is the one group
   * most likely to be reading the `aria-disabled` that promised it would not.
   *
   * Arrows still *land* on it, deliberately: `aria-disabled` means "here and
   * unavailable", and skipping it would hide from a screen-reader user a row
   * everybody else can see.
   */
  const ITEMS: MenuItem[] = [
    { id: "archive", label: "Archive" },
    { id: "restore", label: "Reopen closed", disabled: true },
  ];

  /**
   * One `act` per key, deliberately.
   *
   * Batching the presses into a single `act` looks tidier and moves the focus
   * exactly once: the listener closes over `focus`, so two dispatches inside
   * one batch both read the same stale value and both land on the first row.
   * That is not a subtlety of this menu — it is how the component actually
   * behaves under a real keyboard, one event per frame — and a helper that
   * hides it silently tests the wrong row.
   */
  const arrowTo = (index: number) => {
    for (let at = 0; at <= index; at += 1) {
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
      });
    }
  };

  const enter = () => {
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  };

  test("Enter on it dispatches nothing", () => {
    const menu = mountPopover({ x: 100, y: 100 }, DESKTOP, ITEMS);
    arrowTo(1);
    enter();
    expect(menu.selected).toEqual([]);
  });

  test("while Enter on the row above it still does", () => {
    const menu = mountPopover({ x: 100, y: 100 }, DESKTOP, ITEMS);
    arrowTo(0);
    enter();
    expect(menu.selected).toEqual(["archive"]);
  });

  test("and the menu stays open rather than closing on a press that did nothing", () => {
    const menu = mountPopover({ x: 100, y: 100 }, DESKTOP, ITEMS);
    arrowTo(1);
    enter();
    expect(menu.dismissals).toBe(0);
  });
});
