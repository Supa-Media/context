/**
 * Which hosts draw the Tex landing, the waitlist receipt's storage rules, and
 * the Tex-worded join errors (Tex launch, 2026-10-20).
 */

import { describe, expect, test } from "@jest/globals";
import { isTexHost } from "../features/site/host";
import { forgetReceipt, readReceipt, saveReceipt } from "../features/tex/launch/receipt";
import { texJoinError } from "../features/tex/launch/joinError";

describe("isTexHost", () => {
  test("only tex.lc and its staging host", () => {
    expect(isTexHost("tex.lc")).toBe(true);
    expect(isTexHost("tex-staging.context.lc")).toBe(true);
    for (const host of ["context.lc", "www.tex.lc", "tex.lc.example.test", "eviltex.lc", "tex.cool", null]) {
      expect(isTexHost(host)).toBe(false);
    }
  });
});

describe("the receipt in storage", () => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };

  test("keeps a well-formed receipt and forgets it", () => {
    saveReceipt("cd".repeat(32));
    expect(readReceipt()).toBe("cd".repeat(32));
    forgetReceipt();
    expect(readReceipt()).toBeNull();
  });

  test("refuses anything that is not a receipt, either way", () => {
    saveReceipt("not-a-receipt");
    expect(readReceipt()).toBeNull();
    store.set("context.waitlistReceipt", "<script>");
    expect(readReceipt()).toBeNull();
  });
});

describe("texJoinError", () => {
  test("success says nothing, failures never offer email", () => {
    for (const ok of [null, "sent", "joined", "already"] as const) expect(texJoinError(ok)).toBeNull();
    for (const bad of ["invalid_phone", "too_many", "unavailable", "failed"] as const) {
      expect(texJoinError(bad)).not.toMatch(/email/i);
    }
  });
});
