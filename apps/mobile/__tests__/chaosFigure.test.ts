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

describe("tugging at its yarn (a crowded folder's Tex)", () => {
  test("left out, Tex is exactly as it always was: no yarn", () => {
    expect(figureParts(58, { small: false }).yarn).toBeNull();
    expect(figureParts(58, { small: false, tug: undefined })).toEqual(
      figureParts(58, { small: false }),
    );
  });
  test("tugging: a strand from the tangle to the hand, a hand on its head, eyes on the strand", () => {
    const still = figureParts(58, { small: false });
    const tugging = figureParts(58, { small: false, tug: 1 });
    expect(tugging.yarn).not.toBeNull();
    // The hauling hand is where the yarn ends.
    const arm = numbers(tugging.limbs[2]!.d);
    const yarn = numbers(tugging.yarn!.d);
    expect(yarn.slice(-2)).toEqual(arm.slice(-2));
    expect(tugging.limbs[3]!.d).not.toBe(still.limbs[3]!.d);
    expect(tugging.googly.pupils[0]!.cx).toBeGreaterThan(still.googly.pupils[0]!.cx);
  });
  test("the harder the pull, the further the hand and the tauter the strand", () => {
    const slack = figureParts(58, { small: false, tug: 0 });
    const taut = figureParts(58, { small: false, tug: 1 });
    expect(numbers(taut.limbs[2]!.d).at(-2)!).toBeGreaterThan(numbers(slack.limbs[2]!.d).at(-2)!);
    expect(taut.strands[0]!.d).not.toBe(slack.strands[0]!.d);
  });
  test("a calm-looking Tex still has its arms while it tugs", () => {
    expect(figureParts(31, { small: false }).limbOpacity).toBeLessThan(0.5);
    expect(figureParts(31, { small: false, tug: 0.5 }).limbOpacity).toBeGreaterThanOrEqual(0.85);
  });
});
