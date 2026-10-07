import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import { reportMetaLead } from "../features/auth/metaPixel";

const holder = globalThis as unknown as { window?: { fbq?: unknown } };
const hadWindow = "window" in holder;
const realWindow = holder.window;

afterEach(() => {
  if (hadWindow) holder.window = realWindow;
  else delete holder.window;
});

describe("the Meta Lead pixel event", () => {
  test("fires with the server's id as its eventID where the pixel is loaded", () => {
    const calls: unknown[][] = [];
    holder.window = { fbq: (...args: unknown[]) => calls.push(args) };
    reportMetaLead("waitlist-abc");
    expect(calls).toEqual([["track", "Lead", {}, { eventID: "waitlist-abc" }]]);
  });

  test("does nothing without the pixel or an id", () => {
    holder.window = {};
    expect(() => reportMetaLead("waitlist-abc")).not.toThrow();
    const calls: unknown[][] = [];
    holder.window = { fbq: (...args: unknown[]) => calls.push(args) };
    reportMetaLead(undefined);
    expect(calls).toEqual([]);
  });
});

/** Meta's browser ids, sent to `waitlist.enter` (`features/auth/metaBrowserIds.ts`). */
function load(): typeof import("../features/auth/metaBrowserIds") {
  let mod: typeof import("../features/auth/metaBrowserIds") | undefined;
  jest.isolateModules(() => {
    mod = require("../features/auth/metaBrowserIds");
  });
  return mod!;
}

describe("Meta's browser ids", () => {
  beforeEach(() => {
    try {
      window.sessionStorage.clear();
      document.cookie = "_fbc=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
      document.cookie = "_fbp=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    } catch {
      // No DOM in this environment.
    }
  });

  test("builds fbc from the landing fbclid when the pixel has not set one", () => {
    const { captureFbclid, metaBrowserIds } = load();
    expect(metaBrowserIds()).toEqual({});
    captureFbclid("?page=pricing&fbclid=IwAR0abc", 1759700000000);
    expect(metaBrowserIds()).toEqual({ fbc: "fb.1.1759700000000.IwAR0abc" });
  });

  test("ignores an fbclid that is not one", () => {
    const { captureFbclid, metaBrowserIds } = load();
    captureFbclid("?fbclid=%3Cscript%3E", 1759700000000);
    expect(metaBrowserIds()).toEqual({});
  });
});
