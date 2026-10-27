/**
 * A computer never gets the phone layout, however narrow its window.
 *
 * Dev2, 2026-10-27, of a narrow browser tab on context.lc: "why web version
 * transforming into mobile UI?" The phone layout is for a hand holding a
 * touch screen, so `compact` needs a narrow width *and* a touch screen as the
 * main way in. `pageOnComputer` in features/app/density.ts is the rule; the
 * Mac app's half is in shellTitleBand.test.ts.
 *
 * ## Sabotage record
 *
 *   `densityFor` ignoring `onComputer`                                   3
 *   `finePointer` caching the first browser's answer forever            2
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { densityFor, pageOnComputer } from "../features/app/frame";
import { paletteFor } from "../features/design/theme";
import { layout } from "../features/design/tokens";

type Scope = { matchMedia?: unknown };
const original = (globalThis as Scope).matchMedia;
const asked: string[] = [];

/** A browser whose main pointer is a mouse (`fine`) or a finger (`coarse`). */
function pointer(kind: "fine" | "coarse"): void {
  (globalThis as Scope).matchMedia = (query: string) => {
    asked.push(query);
    return { matches: kind === "fine" && query === "(hover: hover) and (pointer: fine)", media: query };
  };
}

afterEach(() => {
  (globalThis as Scope).matchMedia = original;
  asked.length = 0;
});

describe("a narrow window on a computer", () => {
  test("is medium, with the explorer, never the phone layout", () => {
    pointer("fine");
    expect(pageOnComputer()).toBe(true);
    expect(densityFor(390)).toBe("medium");
    expect(densityFor(layout.narrowBreakpoint - 1)).toBe("medium");
    expect(densityFor(layout.wideBreakpoint)).toBe("wide");
    expect(asked).toContain("(hover: hover) and (pointer: fine)");
  });

  test("and does not draw the phone palette either", () => {
    pointer("fine");
    expect(paletteFor("dark", 600)).toBe("dark");
  });
});

describe("a phone or a tablet in the hand", () => {
  test("still takes the phone layout below the breakpoint", () => {
    pointer("coarse");
    expect(pageOnComputer()).toBe(false);
    expect(densityFor(390)).toBe("compact");
    expect(densityFor(layout.narrowBreakpoint)).toBe("medium");
    expect(paletteFor("dark", 390)).toBe("darkPhone");
  });

  test("and so does a page that cannot ask (the native app, jsdom)", () => {
    (globalThis as Scope).matchMedia = undefined;
    expect(pageOnComputer()).toBe(false);
    expect(densityFor(390)).toBe("compact");
  });
});

test("the answer follows the browser it is asked in, not the first one seen", () => {
  pointer("coarse");
  expect(densityFor(390)).toBe("compact");
  pointer("fine");
  expect(densityFor(390)).toBe("medium");
});
