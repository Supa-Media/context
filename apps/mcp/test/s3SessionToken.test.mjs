import test from "node:test";
import assert from "node:assert/strict";
import { S3Store } from "../src/store/s3.js";
import { storeForBinding } from "../src/store/factory.js";

/*
  A temporary R2 credential (an access key, a secret and a session token) is
  what a brand-new managed bucket is served with until its own key has
  propagated. R2 refuses the key and secret without the token, so the token
  must ride on every request, inside the signature, and never in a URL.
*/

function recordingStore(extra = {}) {
  const calls = [];
  const store = new S3Store({
    endpoint: "https://s3.example.test",
    region: "auto",
    bucket: "bucket",
    accessKeyId: "temp-access-key",
    secretAccessKey: "temp-secret-key",
    now: () => new Date("2026-10-29T12:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return new Response("hello", { status: 200, headers: { etag: '"e"' } });
    },
    ...extra,
  });
  return { store, calls };
}

test("a session token is sent and signed on every request", async () => {
  const { store, calls } = recordingStore({ sessionToken: "session-token-obviously-fake" });
  await store.get("note.md");
  const headers = calls[0].options.headers;
  assert.equal(headers["x-amz-security-token"], "session-token-obviously-fake");
  assert.match(headers.Authorization, /SignedHeaders=[^,]*x-amz-security-token/);
  assert.ok(!calls[0].url.toString().includes("session-token"));
});

test("without one, no token header is sent", async () => {
  const { store, calls } = recordingStore();
  await store.get("note.md");
  assert.equal(calls[0].options.headers["x-amz-security-token"], undefined);
  assert.doesNotMatch(calls[0].options.headers.Authorization, /x-amz-security-token/);
});

test("the token is hidden from serialization, like the secret", () => {
  const { store } = recordingStore({ sessionToken: "session-token-obviously-fake" });
  assert.ok(!JSON.stringify(store).includes("session-token-obviously-fake"));
  assert.ok(!JSON.stringify({ ...store }).includes("session-token-obviously-fake"));
});

test("a binding's session token reaches the store it builds", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response("hello", { status: 200, headers: { etag: '"e"' } });
  };
  try {
    const store = storeForBinding({
      provider: "r2",
      endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "ctx-example",
      accessKeyId: "temp-access-key",
      secretAccessKey: "temp-secret-key",
      sessionToken: "session-token-obviously-fake",
      capabilities: { conditionalWrite: true },
      status: "connected",
    });
    await store.get("note.md");
    assert.equal(calls.at(-1).options.headers["x-amz-security-token"], "session-token-obviously-fake");
  } finally {
    globalThis.fetch = original;
  }
});
