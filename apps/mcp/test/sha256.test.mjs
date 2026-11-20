// The synchronous SHA-256 (`texStore/sha256.js`) is the object's etag. It has to match `crypto.subtle`, because a save
// computed with one and stored with the other would fail its own conditional write.
import assert from "node:assert/strict";
import { test } from "node:test";

import { etagHex, sha256 } from "../../../packages/tex/gateway/texStore/sha256.js";

async function subtle(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return digest;
}

test("sha256 matches crypto.subtle, including the etag's first 16 bytes", async () => {
  const samples = [
    new Uint8Array(0),
    new TextEncoder().encode("abc"),
    new TextEncoder().encode("a".repeat(200)),
    new TextEncoder().encode("notes/hello.md\n---\ndate modified:\n---\n"),
  ];
  for (const bytes of samples) {
    const want = await subtle(bytes);
    assert.deepEqual(sha256(bytes), want);
    let hex = "";
    for (let index = 0; index < 16; index += 1) hex += want[index].toString(16).padStart(2, "0");
    assert.equal(etagHex(bytes), hex);
  }
});
