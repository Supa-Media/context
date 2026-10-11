import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * Which landing page (`/a` to `/c`) a visit arrived at, kept for the waitlist
 * join (`features/auth/landingPage.ts`). A fresh module per test, since what it
 * remembers lives in the module. Session storage is a small in-memory stand-in
 * on `window`, because the test environment is node.
 */
function load(): typeof import("../features/auth/landingPage") {
  let mod: typeof import("../features/auth/landingPage") | undefined;
  jest.isolateModules(() => {
    mod = require("../features/auth/landingPage");
  });
  return mod!;
}

class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  clear(): void {
    this.items.clear();
  }
}

let session: MemoryStorage;

beforeEach(() => {
  session = new MemoryStorage();
  (globalThis as unknown as { window: unknown }).window = { sessionStorage: session };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("the landing page", () => {
  test("is the page the visit arrived at", () => {
    const { captureLandingPage, landingPage } = load();
    expect(landingPage()).toBeUndefined();
    captureLandingPage("/c");
    expect(landingPage()).toBe("c");
  });

  test("the home page counts as the default page", () => {
    const { captureLandingPage, landingPage } = load();
    captureLandingPage("/");
    expect(landingPage()).toBe("a");
  });

  test("a path that is not a landing page is ignored", () => {
    const { captureLandingPage, landingPage } = load();
    captureLandingPage("/login");
    captureLandingPage("/A");
    expect(landingPage()).toBeUndefined();
    expect(session.getItem("context.landing")).toBeNull();
  });

  test("the first page seen this session is kept, and it is stored for the session", () => {
    const { captureLandingPage, landingPage } = load();
    captureLandingPage("/c");
    captureLandingPage("/b");
    expect(landingPage()).toBe("c");
    expect(session.getItem("context.landing")).toBe("c");
  });

  test("a page stored by an earlier load of the app is not overwritten", () => {
    session.setItem("context.landing", "c");
    const { captureLandingPage, landingPage } = load();
    expect(landingPage()).toBe("c");
    captureLandingPage("/b");
    expect(landingPage()).toBe("c");
    expect(session.getItem("context.landing")).toBe("c");
  });

  test("a stored value that is not a landing page is replaced by the first real one", () => {
    session.setItem("context.landing", "<script>");
    const { captureLandingPage, landingPage } = load();
    expect(landingPage()).toBeUndefined();
    captureLandingPage("/b");
    expect(landingPage()).toBe("b");
  });
});
