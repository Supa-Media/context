import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldHandleAuthCode, shouldHandleCodeHere } from "../features/auth/handleCode";

/**
 * The rule that keeps a Dropbox connect from signing its owner out.
 *
 * `ConvexAuthProvider` redeems any `?code=` it is not told to ignore, and a
 * failed redemption **stores** the resulting sign-out. `/connect/…` routes
 * carry foreign OAuth codes, so the predicate must refuse them and admit
 * everything else — the invitation flow's emailed `?code=` really is a
 * sign-in code and must keep working.
 */
describe("whose code is it", () => {
  test("a /connect/ route's code is never auth's", () => {
    expect(shouldHandleAuthCode("/connect/dropbox")).toBe(false);
    // The next provider under the prefix is protected before it exists.
    expect(shouldHandleAuthCode("/connect/google-drive")).toBe(false);
  });

  test("everywhere else the sign-in link keeps working", () => {
    expect(shouldHandleAuthCode("/")).toBe(true);
    expect(shouldHandleAuthCode("/login")).toBe(true);
    expect(shouldHandleAuthCode("/invite")).toBe(true);
    expect(shouldHandleAuthCode("/console")).toBe(true);
  });

  test("a lookalike prefix is not the prefix", () => {
    expect(shouldHandleAuthCode("/connections")).toBe(true);
  });
});

describe("the zero-argument form the provider receives", () => {
  test("reads the live pathname", () => {
    const original = globalThis.window;
    (globalThis as { window?: unknown }).window = {
      location: { pathname: "/connect/dropbox" },
    };
    try {
      expect(shouldHandleCodeHere()).toBe(false);
    } finally {
      (globalThis as { window?: unknown }).window = original;
    }
  });

  test("with no window (native), auth keeps its default", () => {
    const original = globalThis.window;
    delete (globalThis as { window?: unknown }).window;
    try {
      expect(shouldHandleCodeHere()).toBe(true);
    } finally {
      (globalThis as { window?: unknown }).window = original;
    }
  });
});

/**
 * The wiring, pinned structurally: the predicate exists to be PASSED, and a
 * root layout that stops passing it brings the bug back with every test
 * above still green. The render path can't be mounted here (the root layout
 * pulls in expo-router's Slot), so the layout source is the assertable fact.
 */
describe("the root layout passes it", () => {
  test("SupaConvexProvider receives shouldHandleCode", () => {
    const layout = readFileSync(
      join(__dirname, "..", "app", "_layout.tsx"),
      "utf8",
    );
    expect(layout).toContain("shouldHandleCode={shouldHandleCodeHere}");
  });
});
