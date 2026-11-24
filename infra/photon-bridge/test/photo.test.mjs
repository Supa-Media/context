import assert from "node:assert/strict";
import test from "node:test";

import { readWhole } from "../container/photo.mjs";

function streamOf(parts) {
  const stream = {
    closed: false,
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
    },
    async close() {
      stream.closed = true;
    },
  };
  return stream;
}

test("a group photo is the stream's primary chunks, joined, and the stream is closed", async () => {
  const stream = streamOf([{ type: "header", info: {} }, { type: "primaryChunk", data: new Uint8Array([1, 2]) }, { type: "otherChunk", data: new Uint8Array([9]) }, { type: "primaryChunk", data: new Uint8Array([3]) }]);
  assert.deepEqual([...(await readWhole(stream, 10))], [1, 2, 3]);
  assert.equal(stream.closed, true);
});

test("a photo past the limit, or with no bytes, is refused, and the stream is still closed", async () => {
  const big = streamOf([{ type: "primaryChunk", data: new Uint8Array(6) }, { type: "primaryChunk", data: new Uint8Array(6) }]);
  await assert.rejects(readWhole(big, 10), { status: 413, code: "photo_too_large" });
  assert.equal(big.closed, true);
  const empty = streamOf([{ type: "header", info: {} }]);
  await assert.rejects(readWhole(empty, 10), { status: 502, code: "photo_empty" });
  assert.equal(empty.closed, true);
});
