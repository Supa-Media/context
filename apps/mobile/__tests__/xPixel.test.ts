import { afterEach, describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { reportWaitlistSignUp, X_WAITLIST_EVENT_ID } from "../features/auth/xPixel";

const holder = globalThis as unknown as { window?: { twq?: unknown } };
const hadWindow = "window" in holder;
const realWindow = holder.window;

afterEach(() => {
  if (hadWindow) holder.window = realWindow;
  else delete holder.window;
});

describe("the waitlist sign-up pixel event", () => {
  test("is the server's event id", () => {
    const server = readFileSync(join(__dirname, "../../convex/functions/lib/xConversion.ts"), "utf8");
    expect(server).toContain(`waitlist: "${X_WAITLIST_EVENT_ID}"`);
  });

  test("fires with the server's conversion id where the pixel is loaded", () => {
    const calls: unknown[][] = [];
    holder.window = { twq: (...args: unknown[]) => calls.push(args) };
    reportWaitlistSignUp("waitlist-abc");
    expect(calls).toEqual([["event", X_WAITLIST_EVENT_ID, { conversion_id: "waitlist-abc" }]]);
  });

  test("does nothing without the pixel or a conversion id", () => {
    holder.window = {};
    expect(() => reportWaitlistSignUp("waitlist-abc")).not.toThrow();
    const calls: unknown[][] = [];
    holder.window = { twq: (...args: unknown[]) => calls.push(args) };
    reportWaitlistSignUp(undefined);
    expect(calls).toEqual([]);
  });
});
