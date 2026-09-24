import { expect, jest, test } from "@jest/globals";
import { ConsoleGrantCache } from "../features/agent/consoleGrantCache";

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
