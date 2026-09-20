import { afterEach, expect, test, vi } from "vitest";
import { emptyAndDeleteR2Bucket } from "../functions/lib/cloudflare";

afterEach(() => vi.unstubAllGlobals());

test("managed test cleanup empties every page then deletes only the named bucket", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  let list = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (method === "GET") {
      list += 1;
      return new Response(JSON.stringify({ success: true, result: list === 1 ? [{ key: "a/b c.md" }] : [] }));
    }
    return new Response(JSON.stringify({ success: true, result: {} }));
  });

  await emptyAndDeleteR2Bucket({
    apiToken: "fake-token",
    accountId: "0123456789abcdef0123456789abcdef",
    bucket: "ctx-safe-test",
  });

  expect(calls.map((call) => `${call.method} ${call.url.replace("https://api.cloudflare.com/client/v4", "")}`)).toEqual([
    "GET /accounts/0123456789abcdef0123456789abcdef/r2/buckets/ctx-safe-test/objects",
    "DELETE /accounts/0123456789abcdef0123456789abcdef/r2/buckets/ctx-safe-test/objects/a/b%20c.md",
    "GET /accounts/0123456789abcdef0123456789abcdef/r2/buckets/ctx-safe-test/objects",
    "DELETE /accounts/0123456789abcdef0123456789abcdef/r2/buckets/ctx-safe-test",
  ]);
});
