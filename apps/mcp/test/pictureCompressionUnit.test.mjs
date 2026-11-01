/**
 * Pictures are kept compressed (`packages/shared/src/pictureCompression.cjs`).
 *
 * What has to hold: a PNG, JPEG, WebP or HEIC goes through the encoder and is
 * kept as the WebP it answers with, scaled down to the edge limit; a GIF, a PDF
 * or a sound never reaches the encoder; and an encoder that is missing, throws,
 * answers with something that is not a WebP, or answers with something no
 * smaller, leaves the original exactly as it came (a HEIC excepted from the
 * last, since no browser draws one).
 *
 * Sabotage, each confirmed to fail a case here: drop the WebP sniff of the
 * encoder's answer, drop the not-smaller check, or let `image/gif` into the
 * compressible list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPRESSED_PICTURE,
  PICTURE_MAX_EDGE,
  compressPicture,
  isCompressiblePicture,
} from "../../../packages/shared/src/pictureCompression.cjs";

const bytesOf = (head, length) => {
  const out = new Uint8Array(length);
  out.set(head);
  return out;
};
const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 4000);
const HEIC = bytesOf([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic")], 40);
const WEBP = bytesOf(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "), 200);
const BIG_WEBP = bytesOf(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "), 9000);
const PNG_TYPE = { contentType: "image/png", extension: "png" };

/** An Images binding stand-in that records what it was asked and answers with `answer`. */
function encoder(answer) {
  const asked = [];
  return {
    asked,
    input(stream) {
      const call = { stream };
      asked.push(call);
      const chain = {
        transform(options) {
          call.transform = options;
          return chain;
        },
        async output(options) {
          call.output = options;
          if (answer instanceof Error) throw answer;
          return { response: () => new Response(answer) };
        },
      };
      return chain;
    },
  };
}

test("a PNG becomes the encoder's WebP, scaled down to the edge limit, lossy", async () => {
  const images = encoder(WEBP);
  const result = await compressPicture(images, PNG, PNG_TYPE);
  assert.equal(result.compressed, true);
  assert.equal(result.contentType, "image/webp");
  assert.equal(result.extension, "webp");
  assert.deepEqual([...result.bytes], [...WEBP]);
  assert.deepEqual(images.asked[0].transform, { width: PICTURE_MAX_EDGE, height: PICTURE_MAX_EDGE, fit: "scale-down" });
  assert.equal(images.asked[0].output.format, COMPRESSED_PICTURE.contentType);
  assert.ok(images.asked[0].output.quality < 100, "lossy, never lossless");
  const sent = new Uint8Array(await new Response(images.asked[0].stream).arrayBuffer());
  assert.deepEqual([...sent], [...PNG], "the encoder is handed the picture's own bytes");
});

test("a GIF, a PDF and a sound never reach the encoder", async () => {
  for (const type of [
    { contentType: "image/gif", extension: "gif" },
    { contentType: "application/pdf", extension: "pdf" },
    { contentType: "audio/mpeg", extension: "mp3" },
  ]) {
    const images = encoder(WEBP);
    const result = await compressPicture(images, PNG, type);
    assert.equal(images.asked.length, 0, type.contentType);
    assert.equal(result.compressed, false);
    assert.equal(result.contentType, type.contentType);
    assert.equal(result.bytes, PNG);
  }
  assert.equal(isCompressiblePicture("image/gif"), false);
  assert.equal(isCompressiblePicture("image/svg+xml"), false);
});

test("no encoder, a failing one, or one answering with something that is not a WebP keeps the original", async () => {
  for (const [images, reason] of [
    [undefined, "no_encoder"],
    [encoder(new Error("boom")), "encoder_failed"],
    [encoder(new Uint8Array(0)), "encoder_answer_not_webp"],
    [encoder(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), "encoder_answer_not_webp"],
    [encoder(PNG.slice(0, 100)), "encoder_answer_not_webp"],
  ]) {
    const result = await compressPicture(images, PNG, PNG_TYPE);
    assert.equal(result.compressed, false, reason);
    assert.equal(result.reason, reason);
    assert.equal(result.contentType, "image/png");
    assert.equal(result.extension, "png");
    assert.deepEqual([...result.bytes], [...PNG]);
  }
});

test("an answer no smaller is not kept, except for a HEIC, which no browser draws", async () => {
  const kept = await compressPicture(encoder(BIG_WEBP), PNG, PNG_TYPE);
  assert.equal(kept.compressed, false);
  assert.equal(kept.reason, "not_smaller");
  const heic = await compressPicture(encoder(WEBP), HEIC, { contentType: "image/heic", extension: "heic" });
  assert.equal(heic.compressed, true);
  assert.equal(heic.contentType, "image/webp");
});

test("an ArrayBuffer is taken as well as a Uint8Array", async () => {
  const result = await compressPicture(encoder(WEBP), PNG.buffer.slice(0), PNG_TYPE);
  assert.equal(result.compressed, true);
});
