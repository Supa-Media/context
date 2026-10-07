import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * The X ad click id the waitlist field forwards (`features/auth/adClickId.ts`).
 * A fresh module per test, since what it remembers lives in the module.
 */
function load(): typeof import("../features/auth/adClickId") {
  let mod: typeof import("../features/auth/adClickId") | undefined;
  jest.isolateModules(() => {
    mod = require("../features/auth/adClickId");
  });
  return mod!;
}

beforeEach(() => {
  try {
    window.sessionStorage.clear();
  } catch {
    // No DOM storage in this environment: the in-memory half is still tested.
  }
});

describe("the ad click id", () => {
  test("is read from the landing query string", () => {
    const { captureAdClickId, adClickId } = load();
    expect(adClickId()).toBeUndefined();
    captureAdClickId("?page=pricing&twclid=abc_123-X");
    expect(adClickId()).toBe("abc_123-X");
  });

  test("ignores a value that is not a click id", () => {
    const { captureAdClickId, adClickId } = load();
    captureAdClickId("?twclid=%3Cscript%3E");
    expect(adClickId()).toBeUndefined();
    captureAdClickId("?twclid=");
    expect(adClickId()).toBeUndefined();
  });

  test("a later page without one keeps the first", () => {
    const { captureAdClickId, adClickId } = load();
    captureAdClickId("?twclid=first");
    captureAdClickId("?page=docs");
    expect(adClickId()).toBe("first");
  });
});
