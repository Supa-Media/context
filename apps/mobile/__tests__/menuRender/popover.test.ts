/**
 * @jest-environment jsdom
 */

/**
 * The pointer popover: flipping rather than clipping at the edges of the
 * window, and its pointer and keyboard interactions.
 *
 * Split out of `menuRender.test.ts`; see `fixtures.ts` in this folder for the
 * module-level rationale and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { itemsFor, mountPopover, note, styleOf } from "./fixtures";

describe("the popover flips rather than clipping", () => {
  /**
   * The whole reason this component computes its own geometry. A popover is
   * `position: fixed`, so a corner that falls outside the window is not
   * somewhere the page can be scrolled to — it is simply gone, and on a file
   * menu the row that goes missing is the last one: "Delete forever…".
   */
  test("with room, it opens down and to the right of the pointer", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    const box = menu.box("menu-root");
    expect(box.left).toBe(300);
    expect(box.top).toBe(200);
    expect(box.width).toBeGreaterThanOrEqual(200);
  });

  test("against the right edge it opens to the left, still on screen", () => {
    const menu = mountPopover({ x: 1150, y: 200 });
    const box = menu.box("menu-root");
    expect(box.left).toBeLessThan(1150);
    expect(box.left + box.width).toBeLessThanOrEqual(1200);
    expect(box.left).toBeGreaterThanOrEqual(0);
  });

  test("against the bottom edge it opens upward, still on screen", () => {
    const menu = mountPopover({ x: 300, y: 780 });
    const box = menu.box("menu-root");
    expect(box.top).toBeLessThan(780);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.top + box.height).toBeLessThanOrEqual(800);
  });

  test("in the bottom-right corner it flips both ways at once", () => {
    const menu = mountPopover({ x: 1180, y: 790 });
    const box = menu.box("menu-root");
    expect(box.left + box.width).toBeLessThanOrEqual(1200);
    expect(box.top + box.height).toBeLessThanOrEqual(800);
  });

  /** A window shorter than the menu has no side that fits; it scrolls. */
  test("a menu taller than the window is bounded by it", () => {
    const menu = mountPopover({ x: 100, y: 100 }, { width: 1200, height: 300 });
    const box = menu.box("menu-root");
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.top + box.height).toBeLessThanOrEqual(300);
    expect(styleOf(menu.panel("menu-root")!, "overflow-y")).not.toBe("visible");
  });

  /**
   * The same rule again, independently: a submenu is a box near an edge too,
   * and it is the box most likely to be near one — it starts where the parent
   * *ends*. One popover per test, because every query in here goes through
   * `document.body` and two mounted menus both answer to `menu-root`.
   */
  test("a submenu opens beside its parent", () => {
    const menu = mountPopover({ x: 200, y: 120 });
    menu.press("menu-item-visibility");
    const parentBox = menu.box("menu-root");
    const subBox = menu.box("menu-sub");
    expect(subBox.left).toBeGreaterThanOrEqual(parentBox.left + parentBox.width - 1);
    expect(subBox.left + subBox.width).toBeLessThanOrEqual(1200);
  });

  test("a submenu with no room to the right opens to the left of its parent", () => {
    const menu = mountPopover({ x: 1150, y: 120 });
    menu.press("menu-item-visibility");
    const parentBox = menu.box("menu-root");
    const subBox = menu.box("menu-sub");
    // Flipped across the parent entirely, rather than landing on top of it.
    expect(subBox.left + subBox.width).toBeLessThanOrEqual(parentBox.left + 1);
    expect(subBox.left).toBeGreaterThanOrEqual(0);
  });
});

describe("the popover's pointer and keyboard", () => {
  test("chords are printed on the web, unlike the sheet", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    expect(menu.panel("menu-root")?.textContent).toContain("⌘D");
  });

  test("a row selects its id and closes", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    menu.press("menu-item-archive");
    expect(menu.selected).toEqual(["archive"]);
    expect(menu.dismissals).toBe(1);
  });

  test("clicking the submenu parent opens it and dispatches nothing", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    menu.press("menu-item-visibility");
    expect(menu.selected).toEqual([]);
    expect(menu.dismissals).toBe(0);
    expect(menu.panel("menu-sub")).not.toBeNull();
  });

  test("down then Enter runs the first item", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    menu.key("ArrowDown");
    menu.key("Enter");
    expect(menu.selected).toEqual(["open"]);
    expect(menu.dismissals).toBe(1);
  });

  /** → enters a submenu, ← leaves it, and neither dispatches the parent. */
  test("the arrow keys walk into a submenu and back out", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    const items = itemsFor({
      target: { kind: "row", row: note("1-projects/plan.md") },
      canEdit: true,
      canSetVisibility: true,
      canShare: true,
      canDownload: true,
      clipboard: null,
      platform: "web",
    });
    const at = items.findIndex((item) => item.id === "visibility");
    for (let step = 0; step <= at; step += 1) menu.key("ArrowDown");

    menu.key("ArrowRight");
    expect(menu.panel("menu-sub")).not.toBeNull();
    expect(menu.selected).toEqual([]);

    menu.key("ArrowLeft");
    expect(menu.panel("menu-sub")).toBeNull();
    expect(menu.selected).toEqual([]);

    // …and Enter inside it runs the child, not the parent.
    menu.key("ArrowRight");
    menu.key("Enter");
    expect(menu.selected).toEqual(["visibilityPrivate"]);
  });

  test("Escape dismisses and chooses nothing", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    menu.key("Escape");
    expect(menu.dismissals).toBe(1);
    expect(menu.selected).toEqual([]);
  });

  test("a click outside dismisses", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(menu.dismissals).toBe(1);
  });

  /**
   * A popover is anchored to a point in a document that can move under it.
   * Re-anchoring against a scroll would leave the menu pointing at whichever
   * row happens to be there now, which is how a menu acts on the wrong file.
   */
  test("scrolling anything dismisses", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    act(() => {
      document.body.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(menu.dismissals).toBe(1);
  });
});
