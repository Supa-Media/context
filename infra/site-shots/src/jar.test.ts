import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { MAX_COOKIES, MAX_ORIGIN_CHARS, parseJar, storageSource } from "./jar";

/** Run the page code on a page at `origin` whose storage starts as `start`. */
function onPage(source: string, origin: string, start: Record<string, string> = {}) {
  const items = new Map(Object.entries(start));
  const localStorage = {
    getItem: (key: string) => (items.has(key) ? items.get(key)! : null),
    setItem: (key: string, value: string) => void items.set(key, String(value)),
  };
  runInNewContext(source, { location: { origin }, localStorage });
  return Object.fromEntries(items);
}

describe("jar", () => {
  it("puts back only the page's own origin's storage, and never over what it holds", () => {
    const source = storageSource({ "https://app.example": { token: "t1", theme: "dark" }, "https://bank.example": { session: "b1" } });
    expect(onPage(source, "https://app.example", { theme: "light" })).toEqual({ theme: "light", token: "t1" });
    expect(onPage(source, "https://evil.example")).toEqual({});
  });

  it("writes what it carries in as data, never as code", () => {
    const source = storageSource({ "https://app.example": { 'k"); globalThis.pwned = 1; ("': '"); globalThis.pwned = 1; ("' } });
    const context: Record<string, unknown> = { location: { origin: "https://app.example" }, localStorage: { getItem: () => null, setItem() {} } };
    runInNewContext(source, context);
    expect(context.pwned).toBeUndefined();
  });

  it("keeps only cookies and https origins it can stand behind", () => {
    const parsed = parseJar({
      cookies: [
        { name: "ok", value: "v", domain: ".a.example", path: "/", secure: true, httpOnly: false, expires: -1, session: true },
        { name: "", value: "v", domain: "a.example", path: "/" },
        { name: "big", value: "x".repeat(5_000), domain: "a.example", path: "/" },
        { name: "part", value: "v", domain: "a.example", path: "/", partitionKey: { topLevelSite: "https://b.example" } },
      ],
      storage: {
        "https://a.example": { k: "v" },
        "http://plain.example": { k: "v" },
        "javascript:alert(1)": { k: "v" },
        "https://huge.example": { k: "x".repeat(60_000), l: "x".repeat(60_000), m: "x".repeat(60_000), n: "x".repeat(60_000), o: "x".repeat(60_000) },
      },
    });
    expect(parsed).toEqual({
      cookies: [{ name: "ok", value: "v", domain: ".a.example", path: "/", secure: true, httpOnly: false }],
      storage: { "https://a.example": { k: "v" } },
    });
    expect(5 * 60_000).toBeGreaterThan(MAX_ORIGIN_CHARS);
    expect(parseJar({ cookies: Array.from({ length: MAX_COOKIES + 5 }, (_, i) => ({ name: `c${i}`, value: "v", domain: "a.example", path: "/" })) })?.cookies).toHaveLength(MAX_COOKIES);
    expect(parseJar("nope")).toBeNull();
    expect(parseJar({ storage: {} })).toBeNull();
  });
});
