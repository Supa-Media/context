import test from "node:test";
import assert from "node:assert/strict";
import { R2Store } from "../src/store/r2.js";
import { S3Store } from "../src/store/s3.js";

test("R2 head returns metadata without reading the body", async () => {
  const calls = [];
  const bucket = {
    async head(key) {
      calls.push(key);
      return { etag: '"r2-etag"', size: 37, httpMetadata: { contentType: "text/markdown; charset=utf-8" } };
    },
    async get() { throw new Error("head must not call get"); },
  };
  const store = new R2Store(bucket, { rootPrefix: "root/" });
  assert.deepEqual(await store.head("note.md"), {
    etag: "r2-etag",
    size: 37,
    contentType: "text/markdown; charset=utf-8",
  });
  assert.deepEqual(calls, ["root/note.md"]);
});

test("R2 head returns undefined when a legacy binding cannot answer metadata", async () => {
  const store = new R2Store({ get: async () => { throw new Error("must not read body"); } });
  assert.equal(await store.head("note.md"), undefined);
});

test("S3 head uses HEAD and returns metadata without a GET body", async () => {
  const calls = [];
  const store = new S3Store({
    endpoint: "https://s3.example.test",
    region: "us-east-1",
    bucket: "bucket",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    rootPrefix: "root/",
    now: () => new Date("2026-08-25T12:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return new Response(null, {
        status: 200,
        headers: {
          etag: '"s3-etag"',
          "content-length": "41",
          "content-type": "text/markdown; charset=utf-8",
        },
      });
    },
  });
  assert.deepEqual(await store.head("note.md"), {
    etag: "s3-etag",
    size: 41,
    contentType: "text/markdown; charset=utf-8",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].url.pathname, "/bucket/root/note.md");
});

test("S3 head preserves unknown size instead of treating missing Content-Length as zero", async () => {
  const store = new S3Store({
    endpoint: "https://s3.example.test",
    region: "us-east-1",
    bucket: "bucket",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    fetchImpl: async () => new Response(null, { status: 200, headers: { etag: '"etag"' } }),
  });
  assert.deepEqual(await store.head("note.md"), { etag: "etag", size: undefined, contentType: undefined });
});

test("S3 head maps a provider 404 to null", async () => {
  const store = new S3Store({
    endpoint: "https://s3.example.test",
    region: "us-east-1",
    bucket: "bucket",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  assert.equal(await store.head("missing.md"), null);
});
