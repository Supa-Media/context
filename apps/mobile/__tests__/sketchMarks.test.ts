import { describe, expect, test } from "@jest/globals";
import { chipMark } from "../features/console/files/noteEditor/chips/PropertyChip";
import { seedOf, sketchStrokes } from "../features/design/components/sketch/sketchGeometry";

/**
 * The drawn marks behind property chips (`design/components/sketch/`).
 *
 * Owner, 2026-11-04, shown seven pill styles: "lets go with c [highlighter].
 * keep b [pencil loop] as an alternative. We may end up mix matching between
 * the app", then "Masking tape is also a good alternative - not a huge fan of
 * the color though on white".
 *
 * ## Sabotage record
 *
 * Run as temporary local edits, and reverted.
 *
 * 1. **`seededRandom` reseeded from `Math.random()`** — "one chip draws the
 *    same marks every time" fails.
 * 2. **`chipMark` marker look swiping every set chip** — "only a status gets
 *    the marker" fails.
 */
describe("sketch geometry", () => {
  test("one chip draws the same marks every time", () => {
    for (const look of ["marker", "underline", "loop", "dashedLoop", "tape"] as const) {
      expect(sketchStrokes(look, 90, 26, seedOf("note-chip-status:done"))).toEqual(sketchStrokes(look, 90, 26, seedOf("note-chip-status:done")));
    }
  });

  test("different chips are drawn by a different hand", () => {
    expect(sketchStrokes("loop", 90, 26, seedOf("a"))).not.toEqual(sketchStrokes("loop", 90, 26, seedOf("b")));
  });

  test("a box too small to draw in gets no marks, and no NaN reaches a path", () => {
    expect(sketchStrokes("loop", 0, 0, 1)).toEqual([]);
    expect(sketchStrokes("marker", Number.NaN, 26, 1)).toEqual([]);
    for (const look of ["marker", "underline", "loop", "dashedLoop", "tape"] as const) {
      for (const stroke of sketchStrokes(look, 40, 26, 7)) expect(stroke.d).not.toMatch(/NaN|Infinity/);
    }
  });

  test("a loop stays near its box: a few points outside, never across the row", () => {
    const [first] = sketchStrokes("loop", 120, 26, seedOf("x"));
    const numbers = first!.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const xs = numbers.filter((_, i) => i % 2 === 0);
    const ys = numbers.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeGreaterThan(-6);
    expect(Math.max(...xs)).toBeLessThan(126);
    expect(Math.min(...ys)).toBeGreaterThan(-5);
    expect(Math.max(...ys)).toBeLessThan(31);
  });

  test("the marker is two broad passes, the pencil looks thin lines", () => {
    const marker = sketchStrokes("marker", 90, 26, 3);
    expect(marker.map((s) => s.pen)).toEqual(["marker", "marker"]);
    expect(Math.min(...marker.map((s) => s.width))).toBeGreaterThan(8);
    expect(sketchStrokes("underline", 90, 26, 3).every((s) => s.pen === "pencil" && s.width < 2)).toBe(true);
    expect(sketchStrokes("tape", 90, 26, 3)[0]!.d.endsWith("Z")).toBe(true);
  });
});

describe("which mark a chip gets", () => {
  test("only a status gets the marker; other values a pencil underline; an unset one nothing until pointed at", () => {
    expect(chipMark("marker", { set: true, status: true, hovered: false })?.look).toBe("marker");
    expect(chipMark("marker", { set: true, status: false, hovered: false })?.look).toBe("underline");
    expect(chipMark("marker", { set: false, status: false, hovered: false })).toBeNull();
    expect(chipMark("marker", { set: false, status: false, hovered: true })?.look).toBe("underline");
  });

  test("the alternatives: a loop round every value, tape under every value", () => {
    expect(chipMark("loop", { set: true, status: true, hovered: false })?.look).toBe("loop");
    expect(chipMark("loop", { set: false, status: false, hovered: false })?.look).toBe("dashedLoop");
    expect(chipMark("tape", { set: true, status: false, hovered: false })?.look).toBe("tape");
    expect(chipMark("tape", { set: false, status: false, hovered: false })).toBeNull();
  });
});
