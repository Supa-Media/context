/**
 * Tex's geometry, ported from the owner's pick (paper3, the googly-eyed
 * scribble that untangles into a #) and drawn as approved on the homepage.
 * Pure: what is drawn at a given chaos, not how.
 */

import { describe, expect, test } from "@jest/globals";
import {
  figureParts,
  scribble,
  SMALL_FIGURE,
} from "../features/chaos/figureGeometry";

const numbers = (d: string): number[] =>
  (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe("the eyes", () => {
  test("googly at every score, calm included: Tex never swaps them for dots", () => {
    for (const chaos of [0, 0.4, 1, 4, 50, 100]) {
      expect(figureParts(chaos, { small: false }).googly.whites).toHaveLength(
        2,
      );
    }
    expect(figureParts(0, { small: false })).not.toHaveProperty("dots");
  });
  test("the pupils drift back to centre as it calms down", () => {
    const [wild] = figureParts(100, { small: false }).googly.pupils;
    const [calm] = figureParts(0, { small: false }).googly.pupils;
    expect(wild!.cx).toBe(-42);
    expect(calm!.cx).toBe(-52);
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
    // Tex's brush: 13 at full chaos, 16 more once it is the #.
    expect(calm.strands[0]!.width).toBeCloseTo(29);
  });
  test("at full chaos it is the plain brush, limbs out, marks and speckles on", () => {
    const wild = figureParts(100, { small: false });
    expect(wild.strands[0]!.width).toBe(13);
    expect(wild.limbs[0]!.width).toBeCloseTo(15.6);
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
    expect(
      figureParts(0, { small: true, minStroke: 20 }).strands[0]!.width,
    ).toBeCloseTo(29);
  });
});
