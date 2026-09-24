/**
 * @jest-environment jsdom
 */

/**
 * One component, two presentations: the phone sheet and the desktop panel,
 * chosen by the layout token rather than a literal.
 *
 * Split out of `paletteRender.test.ts`; see `fixtures.ts` in this folder for
 * the module-level rationale and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
import { DESKTOP, PHONE, layout, mount } from "./fixtures";

describe("one component, two presentations", () => {
  test("a phone gets the full-screen sheet and no floating panel", () => {
    const palette = mount(PHONE);

    expect(palette.find("palette-sheet")).not.toBeNull();
    expect(palette.find("palette-panel")).toBeNull();
    expect(palette.find("palette-scrim")).toBeNull();
    // Cancel is the only way out where there is no Escape key.
    expect(palette.find("palette-cancel")).not.toBeNull();

    palette.unmount();
  });

  test("a desktop gets the floating panel and no sheet", () => {
    const palette = mount(DESKTOP);

    expect(palette.find("palette-panel")).not.toBeNull();
    expect(palette.find("palette-sheet")).toBeNull();
    expect(palette.find("palette-scrim")).not.toBeNull();

    palette.unmount();
  });

  test("the switch is the layout token, not a number typed into the component", () => {
    const narrow = mount(layout.narrowBreakpoint - 1);
    expect(narrow.find("palette-sheet")).not.toBeNull();
    narrow.unmount();

    const wide = mount(layout.narrowBreakpoint);
    expect(wide.find("palette-panel")).not.toBeNull();
    wide.unmount();
  });

  test("a touch row clears the 44pt minimum target", () => {
    const palette = mount(PHONE);
    const row = palette.find("palette-row-0")!;
    const height = Number.parseFloat(window.getComputedStyle(row).height);

    expect(Number.isNaN(height)).toBe(false);
    expect(height).toBeGreaterThanOrEqual(44);

    palette.unmount();
  });

  test("the panel is bounded, so a wide window does not stretch it edge to edge", () => {
    const palette = mount(DESKTOP);
    const panel = palette.find("palette-panel")!;
    expect(window.getComputedStyle(panel).maxWidth).toBe("560px");
    palette.unmount();
  });

  test("both presentations draw the same row", () => {
    // The row is the one piece that must not fork: it carries the highlight.
    const phone = mount(PHONE);
    phone.type("note");
    const onPhone = phone
      .find("palette-row-0")!
      .querySelectorAll('[data-testid="palette-mark"]').length;
    phone.unmount();

    const desktop = mount(DESKTOP);
    desktop.type("note");
    const onDesktop = desktop
      .find("palette-row-0")!
      .querySelectorAll('[data-testid="palette-mark"]').length;
    desktop.unmount();

    expect(onPhone).toBe(onDesktop);
    expect(onPhone).toBeGreaterThan(0);
  });
});
