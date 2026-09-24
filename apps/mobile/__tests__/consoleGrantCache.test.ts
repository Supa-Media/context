import { describe, expect, jest, test } from "@jest/globals";
import { ConsoleGrantCache, GrantTimeoutError, isDefinitiveGrantRefusal } from "../features/agent/consoleGrantCache";

test("editor, presence and subsequent notes share one in-flight grant", async () => {
  const cache = new ConsoleGrantCache("browser-a");
  const grant = { accessToken: "one", expiresAt: Date.now() + 3600000, scopes: [] };
  const mint = jest.fn(async () => grant);
  expect(await Promise.all([cache.get("alpha", mint), cache.get("alpha", mint)])).toEqual([grant, grant]);
  for (let note = 0; note < 50; note++) await cache.get("alpha", mint);
  expect(mint).toHaveBeenCalledTimes(1);
  await cache.get("lumio", mint);
  expect(mint).toHaveBeenCalledTimes(2);
});

test("expiry, one forced renewal and mint failures do not poison the cache", async () => {
  const cache = new ConsoleGrantCache("browser-a");
  const mint = jest.fn(async () => ({ accessToken: "one", expiresAt: Date.now() + 1000, scopes: [] }));
  await cache.get("alpha", mint);
  await cache.get("alpha", mint);
  expect(mint).toHaveBeenCalledTimes(2);
  const failed = jest.fn(async () => { throw new Error("offline"); });
  await expect(cache.get("alpha", failed)).rejects.toThrow("offline");
  const fresh = jest.fn(async () => ({ accessToken: "new", expiresAt: Date.now() + 3600000, scopes: [] }));
  await cache.get("alpha", fresh);
  await cache.get("alpha", fresh, true);
  expect(fresh).toHaveBeenCalledTimes(2);
});

describe("a mint that never answers", () => {
  test("releases every waiter at the deadline and a later request mints afresh", async () => {
    jest.useFakeTimers();
    try {
      const cache = new ConsoleGrantCache("browser-a", 1_000);
      let late!: (grant: { accessToken: string; expiresAt: number; scopes: string[] }) => void;
      const stuck = jest.fn(() => new Promise<{ accessToken: string; expiresAt: number; scopes: string[] }>((resolve) => { late = resolve; }));
      // Editor, presence and agent all wait on the one pending mint.
      const waiters = [cache.get("alpha", stuck), cache.get("alpha", stuck), cache.get("alpha", stuck)];
      jest.advanceTimersByTime(1_000);
      for (const waiter of waiters) await expect(waiter).rejects.toBeInstanceOf(GrantTimeoutError);
      expect(stuck).toHaveBeenCalledTimes(1);

      const fresh = jest.fn(async () => ({ accessToken: "fresh", expiresAt: Date.now() + 3_600_000, scopes: [] }));
      expect((await cache.get("alpha", fresh)).accessToken).toBe("fresh");
      // The abandoned mint answering now must not replace the newer grant.
      late({ accessToken: "late", expiresAt: Date.now() + 3_600_000, scopes: [] });
      await Promise.resolve();
      expect((await cache.get("alpha", fresh)).accessToken).toBe("fresh");
      expect(fresh).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a late answer with nothing newer is still not cached", async () => {
    jest.useFakeTimers();
    try {
      const cache = new ConsoleGrantCache("browser-a", 1_000);
      let late!: (grant: { accessToken: string; expiresAt: number; scopes: string[] }) => void;
      const waiter = cache.get("alpha", () => new Promise((resolve) => { late = resolve; }));
      jest.advanceTimersByTime(1_000);
      await expect(waiter).rejects.toBeInstanceOf(GrantTimeoutError);
      late({ accessToken: "late", expiresAt: Date.now() + 3_600_000, scopes: [] });
      await Promise.resolve();
      const next = jest.fn(async () => ({ accessToken: "next", expiresAt: Date.now() + 3_600_000, scopes: [] }));
      expect((await cache.get("alpha", next)).accessToken).toBe("next");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("refreshing a refused token", () => {
  const grant = (accessToken: string) => ({ accessToken, expiresAt: Date.now() + 3_600_000, scopes: [] });

  test("three consumers refused the same token cause one mint", async () => {
    const cache = new ConsoleGrantCache("browser-a");
    await cache.get("alpha", async () => grant("one"));
    const mint = jest.fn(async () => grant("two"));
    const results = await Promise.all([
      cache.get("alpha", mint, { rejected: "one" }),
      cache.get("alpha", mint, { rejected: "one" }),
      cache.get("alpha", mint, { rejected: "one" }),
    ]);
    expect(results.map((one) => one.accessToken)).toEqual(["two", "two", "two"]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  test("a refusal of a token already replaced returns the replacement without minting", async () => {
    // Minting revokes this instance's previous token, so a consumer that
    // re-minted on news another consumer had already acted on would revoke
    // the replacement everyone else is now using.
    const cache = new ConsoleGrantCache("browser-a");
    await cache.get("alpha", async () => grant("one"));
    await cache.get("alpha", async () => grant("two"), { rejected: "one" });
    const mint = jest.fn(async () => grant("three"));
    expect((await cache.get("alpha", mint, { rejected: "one" })).accessToken).toBe("two");
    expect(mint).not.toHaveBeenCalled();
  });
});

test("only the control plane's membership answers are definitive", () => {
  expect(isDefinitiveGrantRefusal({ data: { code: "WORKSPACE_NOT_FOUND" } })).toBe(true);
  expect(isDefinitiveGrantRefusal({ data: { code: "NO_SCOPES_GRANTED" } })).toBe(true);
  // Transient, or not about membership at all.
  expect(isDefinitiveGrantRefusal({ data: { code: "RATE_LIMITED" } })).toBe(false);
  expect(isDefinitiveGrantRefusal({ data: { code: "NOT_AUTHENTICATED" } })).toBe(false);
  expect(isDefinitiveGrantRefusal(new GrantTimeoutError())).toBe(false);
  expect(isDefinitiveGrantRefusal(new TypeError("Failed to fetch"))).toBe(false);
});
