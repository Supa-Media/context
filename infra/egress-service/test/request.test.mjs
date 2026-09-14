import assert from "node:assert/strict";
import test from "node:test";

import { makePinnedRequest } from "../container/request.mjs";

function response({ statusCode = 200, headers = {}, chunks = [Buffer.from("ok")] } = {}) {
  return { statusCode, headers, async *[Symbol.asyncIterator]() { yield* chunks; } };
}

test("a host resolving to any private address is refused before connection", async () => {
  let connected = false;
  const request = makePinnedRequest({
    resolve: async () => ["93.184.216.34", "127.0.0.1"],
    connect: async () => { connected = true; return response(); },
  });
  await assert.rejects(request({ url: "https://example.com/a", method: "GET" }), {
    code: "NETWORK_PRIVATE_ADDRESS_DENIED",
  });
  assert.equal(connected, false);
});

test("literal IPv4 and IPv6 URLs are refused without DNS", async () => {
  let resolved = false;
  const request = makePinnedRequest({
    resolve: async () => { resolved = true; return ["93.184.216.34"]; },
    connect: async () => response(),
  });
  for (const url of ["https://127.0.0.1/", "https://[::1]/", "https://[2001:4860:4860::8888]/"]) {
    await assert.rejects(request({ url, method: "GET" }), { code: "NETWORK_PRIVATE_ADDRESS_DENIED" });
  }
  assert.equal(resolved, false);
});

test("resolution is pinned to the connection while TLS and Host use the hostname", async () => {
  const calls = [];
  const request = makePinnedRequest({
    resolve: async (hostname) => {
      calls.push({ stage: "resolve", hostname });
      return ["93.184.216.34"];
    },
    connect: async (options) => {
      calls.push({ stage: "connect", options });
      return response({ headers: { "content-type": "text/plain", "set-cookie": "no" } });
    },
  });
  const result = await request({
    url: "https://example.com/a?b=1",
    method: "GET",
    headers: [{ name: "accept", value: "text/plain" }],
  });
  assert.equal(calls[1].options.hostname, "93.184.216.34");
  assert.equal(calls[1].options.servername, "example.com");
  assert.equal(calls[1].options.headers.host, "example.com");
  assert.equal(calls[1].options.path, "/a?b=1");
  assert.equal(result.status, 200);
});

test("a second call resolves again, so a redirect hop that becomes private is refused", async () => {
  let resolutions = 0;
  const request = makePinnedRequest({
    resolve: async () => (++resolutions === 1 ? ["93.184.216.34"] : ["10.0.0.8"]),
    connect: async () => response({ statusCode: 302, headers: { location: "https://redirect.example/" }, chunks: [] }),
  });
  assert.equal((await request({ url: "https://example.com/", method: "GET" })).status, 302);
  await assert.rejects(request({ url: "https://redirect.example/", method: "GET" }), {
    code: "NETWORK_PRIVATE_ADDRESS_DENIED",
  });
});

test("the rebinding attack cannot change the address after validation", async () => {
  let resolverNowSays = "93.184.216.34";
  const request = makePinnedRequest({
    resolve: async () => {
      const answer = resolverNowSays;
      resolverNowSays = "127.0.0.1";
      return [answer];
    },
    connect: async (options) => {
      assert.equal(options.hostname, "93.184.216.34");
      return response();
    },
  });
  await request({ url: "https://example.com/", method: "GET" });
});

test("redirects are returned untouched for Convex to re-authorize", async () => {
  const request = makePinnedRequest({
    resolve: async () => ["93.184.216.34"],
    connect: async () => response({ statusCode: 307, headers: { location: "https://other.example/private" }, chunks: [] }),
  });
  const result = await request({ url: "https://example.com/", method: "GET" });
  assert.equal(result.status, 307);
  assert.equal(result.headers.find(({ name }) => name === "location")?.value, "https://other.example/private");
});

test("responses over two megabytes fail closed", async () => {
  const request = makePinnedRequest({
    resolve: async () => ["93.184.216.34"],
    connect: async () => response({ chunks: [Buffer.alloc(2 * 1024 * 1024), Buffer.from("x")] }),
  });
  await assert.rejects(request({ url: "https://example.com/", method: "GET" }), {
    code: "NETWORK_RESPONSE_TOO_LARGE",
  });
});
