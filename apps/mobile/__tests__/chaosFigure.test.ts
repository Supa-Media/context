/**
 * The chaos figure's geometry, ported from the owner's pick (paper3, the
 * googly-eyed scribble that untangles into a #). Pure: what is drawn at a
 * given chaos, not how.
 */

import { describe, expect, test } from "@jest/globals";
import { figureParts, scribble, SMALL_FIGURE } from "../features/chaos/figureGeometry";

const numbers = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe("the eyes", () => {
  test("googly whenever there is any chaos, two dots only at none", () => {
    expect(figureParts(0, { small: false }).dots).not.toBeNull();
    expect(figureParts(0, { small: false }).googly).toBeNull();
    // paper3 switched at t >= 0.95, which would have been chaos 5; the owner's rule is any chaos at all.
    expect(figureParts(1, { small: false }).dots).toBeNull();
    expect(figureParts(1, { small: false }).googly).not.toBeNull();
    expect(figureParts(4, { small: false }).googly).not.toBeNull();
  });
  test("by the score as shown: 0.4 is 0, 0.5 is 1", () => {
    expect(figureParts(0.4, { small: false }).dots).not.toBeNull();
    expect(figureParts(0.5, { small: false }).googly).not.toBeNull();
  });
});

describe("the scribble", () => {
  test("is the same for a seed, every time, and differs between seeds", () => {
    expect(scribble(7)).toBe(scribble(7));
    expect(scribble(7)[10]).toEqual(scribble(7)[10]);
    expect(scribble(11)[10]).not.toEqual(scribble(7)[10]);
    expect(scribble(7)).toHaveLength(720);
  });
  test("at full calm the four strands are the #'s four strokes", () => {
    const calm = figureParts(0, { small: false });
    expect(calm.strands).toHaveLength(4);
    // The first stroke runs from (40,7) to (30,93) of the icon, scaled 4.4 about (340, 380).
    const [x0, y0] = numbers(calm.strands[0]!.d);
    expect(x0).toBeCloseTo(340 + (40 - 50) * 4.4, 0);
    expect(y0).toBeCloseTo(380 + (7 - 50) * 4.4, 0);
    expect(calm.strands[0]!.width).toBeCloseTo(53);
  });
  test("at full chaos it is the thin brush, limbs out, marks and speckles on", () => {
    const wild = figureParts(100, { small: false });
    expect(wild.strands[0]!.width).toBe(9);
    expect(wild.limbOpacity).toBe(1);
    expect(wild.motion).not.toBeNull();
    expect(wild.speckles).toHaveLength(26);
    const calm = figureParts(0, { small: false });
    expect(calm.limbOpacity).toBe(0);
    expect(calm.motion).toBeNull();
  });
});

describe("small", () => {
  test(`at ${SMALL_FIGURE}px and under: no speckles or motion marks, and thicker strokes`, () => {
    const small = figureParts(100, { small: true, minStroke: 40 });
    expect(small.speckles).toHaveLength(0);
    expect(small.motion).toBeNull();
    expect(small.strands[0]!.width).toBe(40);
    expect(small.limbs[0]!.width).toBe(40);
    // A stroke already thicker than the floor keeps its own width.
    expect(figureParts(0, { small: true, minStroke: 40 }).strands[0]!.width).toBeCloseTo(53);
  });
});
