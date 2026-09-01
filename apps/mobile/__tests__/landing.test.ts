/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { landAfterSignIn } from "../features/auth/landing";

/**
 * **How the app returns somebody to the link that sent them to sign in.**
 *
 * Measured in Chromium against the real router, following
 * `/console/@seyi?note=3-resources%2Fengineering%2Fshipping-an-expo-app-safely.md`
 * signed out. `/login` received the right `next` — the gate's half was already
 * correct — and then `router.replace(next)` landed here:
 *
 *     t+1500ms   /console/@seyi?slug=%40seyi
 *
 * which is the URL a person reported being left on, with the note gone. A real
 * navigation sets the URL to `next` byte-for-byte instead, and the same probe
 * then lands on
 * `/console/@seyi?note=3-resources/engineering/shipping-an-expo-app-safely.md`
 * in one hop.
 *
 * See `features/auth/landing.ts` for why, and `attemptedHref.ts` for the same
 * defect seen from the other side.
 */

const realLocation = window.location;
afterEach(() => {
  Object.defineProperty(window, "location", { value: realLocation, configurable: true });
});

function browserAt(replace: (href: string) => void): void {
  Object.defineProperty(window, "location", {
    value: { pathname: "/login", search: "?next=%2Fconsole", replace },
    configurable: true,
  });
}

const NEXT = "/console/@seyi?note=3-resources%2Fengineering%2Fshipping-an-expo-app-safely.md";

describe("landing somebody back where they were sent", () => {
  test("a browser gets a real navigation, to the href exactly as given", () => {
    const replace = jest.fn();
    const fallback = jest.fn();
    browserAt(replace as (href: string) => void);

    landAfterSignIn(NEXT, fallback as (href: string) => void);

    // Byte-for-byte. Anything that re-parses or re-serializes this is the bug.
    expect(replace).toHaveBeenCalledWith(NEXT);
    expect(fallback).not.toHaveBeenCalled();
  });

  test("…and never the router, because the router is what loses the note", () => {
    // The positive control for the assertion above: a fallback that also ran
    // would put a client-side replace back on the path, and the measured
    // failure would return with the real navigation sitting harmlessly beside
    // it.
    const replace = jest.fn();
    const fallback = jest.fn();
    browserAt(replace as (href: string) => void);

    landAfterSignIn("/console", fallback as (href: string) => void);

    expect(fallback).toHaveBeenCalledTimes(0);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  test("React Native has a window and no location, and falls back to the router", () => {
    const fallback = jest.fn();
    for (const value of [undefined, {}, { pathname: "/login" }, { replace: () => {} }]) {
      Object.defineProperty(window, "location", { value, configurable: true });
      fallback.mockClear();

      landAfterSignIn(NEXT, fallback as (href: string) => void);

      // There is no page to reload on native. The router's navigation is the
      // only mechanism there, and it is the narrower case: the tree below the
      // gate is already mounted after an in-app sign-in.
      expect(fallback).toHaveBeenCalledWith(NEXT);
    }
  });
});
