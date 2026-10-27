/**
 * The guest pass a browser keeps after a texted code (`features/guest/guestPass.ts`), and the words the guest page
 * says when a code didn't go or didn't open anything. The rules a pass is read by are the server's
 * (`apps/convex/__tests__/guestPass.test.ts`); this pins that the browser keeps only a pass of the right shape and
 * forgets it on sign out, and that no answer tells a guest which of the refusals it was.
 */

import { forgetGuestPass, guestStartError, guestVerifyError, readGuestPass, saveGuestPass } from "../features/guest/guestPass";

const PASS = "A".repeat(43);

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the kept pass", () => {
  test("is kept, read back and forgotten", () => {
    (globalThis as { localStorage?: unknown }).localStorage = fakeStorage();
    expect(readGuestPass()).toBeNull();
    saveGuestPass(PASS);
    expect(readGuestPass()).toBe(PASS);
    forgetGuestPass();
    expect(readGuestPass()).toBeNull();
  });

  test("only a pass of the server's shape is kept or read", () => {
    const storage = fakeStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    saveGuestPass("not a pass");
    expect(readGuestPass()).toBeNull();
    storage.setItem("context.guestPass", "<script>");
    expect(readGuestPass()).toBeNull();
  });

  test("no storage, or storage that throws, is no pass rather than a crash", () => {
    expect(readGuestPass()).toBeNull();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => saveGuestPass(PASS)).not.toThrow();
    expect(readGuestPass()).toBeNull();
    expect(() => forgetGuestPass()).not.toThrow();
  });
});

describe("what the page says", () => {
  test("a sent code says nothing, and every failure says what to do", () => {
    expect(guestStartError("sent")).toBeNull();
    expect(guestVerifyError("ok")).toBeNull();
    for (const status of ["invalid_phone", "too_many", "unavailable", "failed"] as const) expect(guestStartError(status)).toMatch(/\.$/);
    for (const status of ["wrong", "too_many", "unavailable"] as const) expect(guestVerifyError(status)).toMatch(/\.$/);
  });
});
