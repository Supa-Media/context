/**
 * @jest-environment jsdom
 */

/**
 * The query driving the list, the matched characters being emphasised, the
 * keyboard, and choosing with a pointer or a thumb.
 *
 * Split out of `paletteRender.test.ts`; see `fixtures.ts` in this folder for
 * the module-level rationale and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
import { DESKTOP, ITEMS, PHONE, darkColors, mount, rgb } from "./fixtures";

describe("the query drives the list", () => {
  test("an untyped palette shows every item, in the order it was given", () => {
    const palette = mount(DESKTOP);
    expect(palette.rowLabels()).toHaveLength(ITEMS.length);
    expect(palette.rowLabels()[0]).toContain("New note");
    expect(palette.find("palette-heading")?.textContent).toBe("Recent");
    palette.unmount();
  });

  test("typing filters the list and reorders what survives", () => {
    const palette = mount(DESKTOP);
    palette.type("note");

    const labels = palette.rowLabels();
    // Filtered: the four items with no `note` subsequence in them are gone.
    expect(labels).toHaveLength(2);
    // Reordered: the command was row 0 a moment ago and is now below the note
    // whose name actually starts with what was typed.
    expect(labels[0]).toContain("notes-on-storage.md");
    expect(labels[1]).toContain("New note");

    palette.unmount();
  });

  test("a query that matches nothing says so, rather than showing an empty box", () => {
    const palette = mount(DESKTOP);
    palette.type("zzzzq");

    expect(palette.rowLabels()).toHaveLength(0);
    expect(palette.find("palette-empty")?.textContent).toBe(
      "Nothing here matches. Try fewer letters.",
    );

    palette.unmount();
  });
});

describe("the matched characters are emphasised", () => {
  test("`Match.ranges` becomes real nodes, weighted apart from the rest", () => {
    const palette = mount(DESKTOP);
    palette.type("note");

    const topRow = palette.find("palette-row-0")!;
    const marks = [...topRow.querySelectorAll<HTMLElement>('[data-testid="palette-mark"]')];

    // `notes-on-storage.md` matches at its first four characters, so the run
    // is exactly what was typed — not merely "some node exists".
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.map((mark) => mark.textContent).join("")).toBe("note");

    // …and it has to *look* different, or the ranges are decoration.
    const emphasis = window.getComputedStyle(marks[0]);
    expect(emphasis.fontWeight).toBe("600");
    expect(emphasis.color).toBe(rgb(darkColors.text));

    palette.unmount();
  });

  test("an untyped palette emphasises nothing", () => {
    // `rank("")` returns empty ranges, and a component that highlighted
    // anything here would be inventing a match.
    const palette = mount(DESKTOP);
    expect(palette.all('[data-testid="palette-mark"]')).toHaveLength(0);
    palette.unmount();
  });
});

describe("the keyboard", () => {
  test("the top match is selected before anything is pressed", () => {
    const palette = mount(DESKTOP);
    expect(palette.selectedRow()?.dataset.testid).toBe("palette-row-0");
    palette.unmount();
  });

  test("↓ and ↑ move the selection, and it wraps", () => {
    const palette = mount(DESKTOP);

    palette.press("ArrowDown");
    expect(palette.selectedRow()?.dataset.testid).toBe("palette-row-1");

    palette.press("ArrowDown");
    expect(palette.selectedRow()?.dataset.testid).toBe("palette-row-2");

    palette.press("ArrowUp");
    expect(palette.selectedRow()?.dataset.testid).toBe("palette-row-1");

    // Up from the top lands on the last row rather than stopping dead.
    palette.press("ArrowUp");
    palette.press("ArrowUp");
    expect(palette.selectedRow()?.dataset.testid).toBe(`palette-row-${ITEMS.length - 1}`);

    palette.unmount();
  });

  test("Enter chooses the selected row, not the first one", () => {
    const palette = mount(DESKTOP);
    palette.type("note");

    // Two matches, and the highlight is deliberately moved off the top one.
    palette.press("ArrowDown");
    palette.press("Enter");

    expect(palette.chosen).toHaveLength(1);
    expect(palette.chosen[0].id).toBe("cmd:new-note");

    palette.unmount();
  });

  test("Escape dismisses", () => {
    const palette = mount(DESKTOP);
    palette.press("Escape");
    expect(palette.dismissals()).toBe(1);
    expect(palette.chosen).toHaveLength(0);
    palette.unmount();
  });

  test("a shrinking result set never leaves Enter pointing at nothing", () => {
    const palette = mount(DESKTOP);

    // Walk to the bottom of the full list, then type something that leaves one
    // row. Without a clamp the selection is off the end and Enter does nothing.
    palette.press("ArrowUp");
    palette.type("tfm");

    expect(palette.rowLabels()).toHaveLength(1);
    palette.press("Enter");
    expect(palette.chosen.map((item) => item.id)).toEqual([
      "1-projects/together-financial-management.md",
    ]);

    palette.unmount();
  });
});

describe("choosing with a pointer or a thumb", () => {
  test("tapping a row chooses that row", () => {
    const palette = mount(PHONE);
    palette.click("palette-row-2");
    expect(palette.chosen.map((item) => item.id)).toEqual(["3-resources/notes-on-storage.md"]);
    palette.unmount();
  });

  test("the scrim dismisses on a pointer layout", () => {
    const palette = mount(DESKTOP);
    palette.click("palette-scrim");
    expect(palette.dismissals()).toBe(1);
    palette.unmount();
  });

  test("Cancel dismisses on a phone", () => {
    const palette = mount(PHONE);
    palette.click("palette-cancel");
    expect(palette.dismissals()).toBe(1);
    palette.unmount();
  });
});
