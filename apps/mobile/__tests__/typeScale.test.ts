import { describe, expect, test } from "@jest/globals";

import { pointerType, touchType, typeFor } from "../features/design/tokens";

/**
 * The type scale's contract.
 *
 * This file exists because `tokens.ts` shipped for the whole life of the app
 * without a type scale, and the cost was measurable rather than aesthetic: 26
 * distinct font sizes across `features/` and `app/`, drifting in half-points.
 * Every assertion below is aimed at the way that happened — one screen at a
 * time, each nudge individually defensible.
 */

const ROLES = ["label", "meta", "ui", "lede", "body", "h3", "h2", "title", "display"] as const;

describe("the type scale", () => {
  test("both densities declare exactly the same roles", () => {
    expect(Object.keys(pointerType).sort()).toEqual(Object.keys(touchType).sort());
  });

  test("the roles are the nine that were designed, and no more", () => {
    // The guard against drifting back: a tenth role is how 9 becomes 26, and
    // it always arrives as one reasonable-looking addition.
    expect(Object.keys(pointerType).sort()).toEqual([...ROLES].sort());
  });

  test.each([
    ["pointer", pointerType],
    ["touch", touchType],
  ])("%s sizes are whole numbers", (_name, scale) => {
    const fractional = Object.entries(scale).filter(([, size]) => !Number.isInteger(size));
    // Half-points are never a decision — they are a nudge that stuck, and they
    // blur on any display that is not 2x.
    expect(fractional).toEqual([]);
  });

  test.each([
    ["pointer", pointerType],
    ["touch", touchType],
  ])("%s sizes are positive", (_name, scale) => {
    expect(Object.values(scale).every((size) => size > 0)).toBe(true);
  });

  test.each([
    ["pointer", pointerType],
    ["touch", touchType],
  ])("%s ascends from label to display", (_name, scale) => {
    const sizes = ROLES.map((role) => scale[role]);
    const ascending = sizes.every((size, index) => index === 0 || size >= sizes[index - 1]!);
    expect(ascending).toBe(true);
  });

  test("touch is not pointer scaled up — the title is deliberately smaller", () => {
    // A phone's measure is roughly 342pt against the console's 640. A title
    // set at the pointer size wraps to three lines there, which is not
    // emphasis, it is an obstacle. This is the one role that shrinks, and it
    // is pinned so that a future "make everything bigger on mobile" cannot
    // quietly take it with the rest.
    expect(touchType.title).toBeLessThan(pointerType.title);
  });

  test("everything a finger drives is at least as large on touch", () => {
    for (const role of ["ui", "lede", "body"] as const) {
      expect(touchType[role]).toBeGreaterThanOrEqual(pointerType[role]);
    }
  });
});

describe("typeFor", () => {
  test("the phone gets the touch scale", () => {
    expect(typeFor("compact")).toBe(touchType);
  });

  test("both pointer densities share one scale", () => {
    // A medium window is a narrower desktop, not a larger phone.
    expect(typeFor("medium")).toBe(pointerType);
    expect(typeFor("wide")).toBe(pointerType);
  });
});
