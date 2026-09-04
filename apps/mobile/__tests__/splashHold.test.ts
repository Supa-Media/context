/**
 * THE LAUNCH IMAGE COMES DOWN WHEN THERE IS SOMETHING BEHIND IT.
 *
 * **Filmed on a native cold launch:** the splash for four hundred
 * milliseconds, then a full second of white, then the console. The white is
 * not a bug in a screen — it is every screen refusing to draw, because
 * `(app)/_layout` renders `null` while `useConvexAuth` restores the stored
 * token and opens its socket. Expo had already dismissed the launch image, on
 * the question it answers by default: *is the bundle ready*, rather than *is
 * there anything to look at*.
 *
 * Three properties, and the third is the one that keeps this from being a way
 * to ship an app that will not start:
 *
 *  1. Holding prevents the automatic dismissal.
 *  2. Releasing hides it, once, however many callers ask.
 *  3. **The deadline hides it anyway.** What is being waited on is a network
 *     round trip — offline, `isLoading` stays true for as long as the socket
 *     keeps trying, and without this that is a permanent launch image.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

const prevented: number[] = [];
const hidden: number[] = [];

jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: async () => {
    prevented.push(Date.now());
    return true;
  },
  hideAsync: async () => {
    hidden.push(Date.now());
    return true;
  },
}));

import {
  SPLASH_DEADLINE_MS,
  holdSplash,
  releaseSplash,
  resetSplashForTests,
} from "../features/app/splash";

afterEach(() => {
  resetSplashForTests();
  prevented.length = 0;
  hidden.length = 0;
  jest.useRealTimers();
});

describe("holding the launch image", () => {
  test("stops it being dismissed the moment the bundle is ready", () => {
    jest.useFakeTimers();
    holdSplash();
    expect(prevented).toHaveLength(1);
    expect(hidden).toHaveLength(0);
  });

  test("and holding twice is still one hold", () => {
    jest.useFakeTimers();
    holdSplash();
    holdSplash();
    expect(prevented).toHaveLength(1);
  });
});

describe("releasing it", () => {
  test("hides it", () => {
    jest.useFakeTimers();
    holdSplash();
    releaseSplash();
    expect(hidden).toHaveLength(1);
  });

  test("and every caller may assume it is first", () => {
    // The effect that calls this runs on every change of auth state, and the
    // deadline calls it too. Hiding twice is a warning on some platforms and a
    // flicker on none, but a module that only works when called once is a
    // module that will be called twice.
    jest.useFakeTimers();
    holdSplash();
    releaseSplash();
    releaseSplash();
    jest.advanceTimersByTime(SPLASH_DEADLINE_MS + 1);
    expect(hidden).toHaveLength(1);
  });
});

describe("the deadline", () => {
  test("hides it even when nothing ever resolves", () => {
    /*
      Offline. The session cannot be restored, `isLoading` stays true, and
      nothing calls `releaseSplash`. Without this the app never starts — and
      the screen behind is not empty, it is the sign-in the auth gate redirects
      to when there is no session.
    */
    jest.useFakeTimers();
    holdSplash();
    expect(hidden).toHaveLength(0);
    jest.advanceTimersByTime(SPLASH_DEADLINE_MS + 1);
    expect(hidden).toHaveLength(1);
  });

  test("but a release before it wins, and cancels it", () => {
    // The negative control for the test above: a module that only ever hid on
    // the deadline would pass it, and would hold every launch for four
    // seconds.
    jest.useFakeTimers();
    holdSplash();
    jest.advanceTimersByTime(200);
    releaseSplash();
    expect(hidden).toHaveLength(1);
    jest.advanceTimersByTime(SPLASH_DEADLINE_MS + 1);
    expect(hidden).toHaveLength(1);
  });
});
