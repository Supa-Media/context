/**
 * @jest-environment jsdom
 */

/**
 * THE HANDSHAKE THAT LETS THE TOP BAR HOLD THE TRAFFIC LIGHTS.
 *
 * `docs/decisions/desktop.md`, "The band moves into the bar". The root band is
 * mounted above every route, so it cannot see whether the route below it has a
 * bar tall enough to carry the shell's buttons itself — and the console, at a
 * pointer density, does. `topChrome.ts` is the one flag they agree through,
 * and this file is what it promises.
 *
 * The store is deliberately the same shape as `bottomChrome.ts`, so the checks
 * are the same ones `bottomChrome`'s own suite makes about the other edge, plus
 * the two that are specific to this one: it is idempotent, and it goes back to
 * `false` when the frame that claimed it leaves.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   `setTopChromeHoldsLights` notifying unconditionally            1
 *   ...not notifying at all                                        2
 *   ...coercing with `!!next` instead of `next === true`           1
 *   `subscribeTopChrome` returning a no-op unsubscribe             1
 *   `lightsInBarFor` answering `true` at compact                   2
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import {
  setTopChromeHoldsLights,
  subscribeTopChrome,
  topChromeHoldsLights,
} from "../features/app/topChrome";
import { densityFor, lightsInBarFor } from "../features/app/frame";
import { layout } from "../features/design/tokens";

/** Two frames, as far as the store is concerned. */
const FRAME = "frame-1";
const OTHER = "frame-2";

beforeEach(() => {
  setTopChromeHoldsLights(FRAME, false);
  setTopChromeHoldsLights(OTHER, false);
});
afterEach(() => {
  setTopChromeHoldsLights(FRAME, false);
  setTopChromeHoldsLights(OTHER, false);
});

describe("the flag itself", () => {
  test("nothing holds the lights until something says it does", () => {
    expect(topChromeHoldsLights()).toBe(false);
  });

  test("a frame claims it, and gives it back", () => {
    setTopChromeHoldsLights(FRAME, true);
    expect(topChromeHoldsLights()).toBe(true);
    setTopChromeHoldsLights(FRAME, false);
    expect(topChromeHoldsLights()).toBe(false);
  });

  test("subscribers hear a change", () => {
    let heard = 0;
    const stop = subscribeTopChrome(() => {
      heard += 1;
    });
    setTopChromeHoldsLights(FRAME, true);
    expect(heard).toBe(1);
    stop();
  });

  test("IDEMPOTENT — the same answer twice notifies nobody", () => {
    /*
      The frame publishes from a layout effect on every render, so a store
      that notified unconditionally would re-render the root band on every
      keystroke in the editor. Same argument as `setBottomChromeHeight`.
    */
    setTopChromeHoldsLights(FRAME, true);
    let heard = 0;
    const stop = subscribeTopChrome(() => {
      heard += 1;
    });
    setTopChromeHoldsLights(FRAME, true);
    setTopChromeHoldsLights(FRAME, true);
    expect(heard).toBe(0);
    setTopChromeHoldsLights(FRAME, false);
    expect(heard).toBe(1);
    stop();
  });

  test("A SECOND FRAME LEAVING DOES NOT TAKE THE FIRST ONE'S CLAIM WITH IT", () => {
    /*
      The reason this is a set and not a boolean, and the reason it is not
      `bottomChrome.ts`'s shape. Two frames mounted at once, the second
      claiming and the first unmounting a commit later: a bare `false` would
      put the band back up over a bar that is still holding the buttons, and
      the frame that still holds them would never re-render to say so again.
      It would sit wrong until something unrelated moved.
    */
    setTopChromeHoldsLights(FRAME, true);
    setTopChromeHoldsLights(OTHER, true);
    setTopChromeHoldsLights(FRAME, false);
    expect(topChromeHoldsLights()).toBe(true);

    setTopChromeHoldsLights(OTHER, false);
    expect(topChromeHoldsLights()).toBe(false);
  });

  test("a claim nobody could release again is refused rather than stored", () => {
    // An empty or non-string key has no owner that could ever take it back
    // out, so storing it would hold the band down for the life of the page.
    setTopChromeHoldsLights("", true);
    expect(topChromeHoldsLights()).toBe(false);
    setTopChromeHoldsLights(undefined as unknown as string, true);
    expect(topChromeHoldsLights()).toBe(false);
  });

  test("an unsubscribed listener hears nothing more", () => {
    let heard = 0;
    const stop = subscribeTopChrome(() => {
      heard += 1;
    });
    stop();
    setTopChromeHoldsLights(FRAME, true);
    expect(heard).toBe(0);
  });

  test("only a literal true is a claim — nothing else may smuggle one in", () => {
    // `next === true` rather than a truthiness coercion, because the callers
    // are two booleans away from a `number | undefined` and a stray `1` that
    // stood the band down would be invisible until a Mac ran it.
    setTopChromeHoldsLights(FRAME, undefined as unknown as boolean);
    expect(topChromeHoldsLights()).toBe(false);
    setTopChromeHoldsLights(FRAME, 1 as unknown as boolean);
    expect(topChromeHoldsLights()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* which layouts can take the job at all                                      */
/* -------------------------------------------------------------------------- */

describe("lightsInBarFor", () => {
  test("a pointer bar is a real region and can carry them", () => {
    expect(lightsInBarFor("medium")).toBe(true);
    expect(lightsInBarFor("wide")).toBe(true);
  });

  test("THE PHONE BAR CANNOT — it is transparent and lies over the note", () => {
    /*
      `topBarCompact` is `position: "absolute"` with no fill, over a document
      that scrolls under it. Buttons placed there would sit on the note's own
      first line rather than on any chrome.
    */
    expect(lightsInBarFor("compact")).toBe(false);
  });

  test("...and a console window narrowed past the breakpoint is that layout", () => {
    // Reachable by dragging an edge, not only by owning a phone: the console
    // window's `minWidth` is well under `narrowBreakpoint`.
    expect(densityFor(layout.narrowBreakpoint - 1)).toBe("compact");
    expect(lightsInBarFor(densityFor(layout.narrowBreakpoint - 1))).toBe(false);
    expect(lightsInBarFor(densityFor(layout.narrowBreakpoint))).toBe(true);
  });
});
