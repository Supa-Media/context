import { describe, expect, test } from "@jest/globals";
import { autoFitColumns, autoFitItemWidth } from "../features/design/grid";

/**
 * The behaviour being pinned is the one flexbox gets wrong: with four items and
 * three columns, the lone item on the last row must stay one column wide rather
 * than stretching across the container.
 */
describe("autoFitColumns", () => {
  test("fits as many minimum-width columns as the gaps allow", () => {
    // The Storage pane's `.grid2`: minmax(238px, 1fr) with an 11px gap.
    expect(autoFitColumns(845, 238, 11)).toBe(3);
    expect(autoFitColumns(1000, 238, 11)).toBe(4);
    expect(autoFitColumns(500, 238, 11)).toBe(2);
  });

  test("never drops below one column, however narrow", () => {
    expect(autoFitColumns(100, 238, 11)).toBe(1);
    expect(autoFitColumns(0, 238, 11)).toBe(1);
    expect(autoFitColumns(-50, 238, 11)).toBe(1);
  });

  test("counts the gap as part of what a column costs", () => {
    // Exactly two 100px columns plus one 10px gap.
    expect(autoFitColumns(210, 100, 10)).toBe(2);
    // One pixel short of that, and only one column fits.
    expect(autoFitColumns(209, 100, 10)).toBe(1);
  });

  test("a zero-width minimum does not divide by nothing", () => {
    expect(autoFitColumns(800, 0, 10)).toBe(1);
  });
});

describe("autoFitItemWidth", () => {
  test("columns share the width left after the gaps", () => {
    expect(autoFitItemWidth(210, 100, 10)).toBe(100);
    // 845 across 3 columns with two 11px gaps → (845 - 22) / 3.
    expect(autoFitItemWidth(845, 238, 11)).toBeCloseTo(274.333, 2);
  });

  test("a single column takes the whole width, with no gap to subtract", () => {
    expect(autoFitItemWidth(300, 238, 11)).toBe(300);
  });

  test("an unmeasured container reports zero so the caller can fall back", () => {
    expect(autoFitItemWidth(0, 238, 11)).toBe(0);
  });

  test("every item is the same width — the last row does not stretch", () => {
    const width = autoFitItemWidth(845, 238, 11);
    const columns = autoFitColumns(845, 238, 11);
    // Four fields over three columns: the fourth is still one column wide.
    const total = width * columns + 11 * (columns - 1);
    expect(total).toBeCloseTo(845, 6);
  });
});
