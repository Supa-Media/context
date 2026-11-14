import assert from "node:assert/strict";
import test from "node:test";

import { chooseMime, fetchFile, MAX_FILE_BYTES, nameFor, readCapped } from "../container/files.mjs";

function bodyOf(chunks, headers = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers });
}

test("a concrete response type wins over the given one; octet-stream does not", () => {
  assert.equal(chooseMime("image/png; charset=binary", "image/jpeg"), "image/png");
  assert.equal(chooseMime("application/pdf", "application/octet-stream"), "application/pdf");
  assert.equal(chooseMime("application/octet-stream", "image/jpeg"), "image/jpeg");
  assert.equal(chooseMime(null, "image/gif"), "image/gif");
  assert.equal(chooseMime("text/html", "image/gif"), "image/gif");
});

test("the name takes the extension its type implies, and keeps a matching one", () => {
  assert.equal(nameFor("photo.jpg", "image/jpeg"), "photo.jpg");
  assert.equal(nameFor("download", "image/png"), "download.png");
  assert.equal(nameFor("photo.bin", "image/png"), "photo.png");
  assert.equal(nameFor("notes.txt", "text/plain"), "notes.txt", "a type with no known extension leaves the name alone");
});

test("a body is read whole when it is under the cap", async () => {
  const bytes = await readCapped(bodyOf([new Uint8Array([1, 2]), new Uint8Array([3])]), 10);
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test("a body over the cap is refused with 413, even without a length header", async () => {
  await assert.rejects(readCapped(bodyOf([new Uint8Array(6), new Uint8Array(6)]), 10), { status: 413, code: "too_large_url" });
});

test("a declared length over the cap is refused before reading", async () => {
  await assert.rejects(readCapped(bodyOf([], { "content-length": String(MAX_FILE_BYTES + 1) })), { status: 413 });
});

test("only https URLs without credentials are fetched", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response("x");
  };
  for (const url of ["http://example.com/a.png", "https://user:pw@example.com/a.png", "ftp://example.com/a", "nope"]) {
    await assert.rejects(fetchFile(url, "image/png", fetchImpl), { status: 400, code: "invalid_url" }, url);
  }
  assert.equal(called, false);
});

test("a fetched file refuses redirects and takes the response's concrete type", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = init;
    return new Response(new Uint8Array([9, 9]), { headers: { "content-type": "image/png" } });
  };
  const file = await fetchFile("https://example.com/a", "image/jpeg", fetchImpl);
  assert.equal(seen.redirect, "error");
  assert.equal(file.mimeType, "image/png");
  assert.deepEqual([...file.bytes], [9, 9]);
});

test("a failed fetch is a 502, not the upstream's words", async () => {
  const fetchImpl = async () => new Response("secret", { status: 404 });
  await assert.rejects(fetchFile("https://example.com/a", "image/png", fetchImpl), { status: 502, code: "source_unavailable" });
});
