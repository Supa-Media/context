/**
 * A pasted picture is compressed on the device before it is uploaded.
 *
 * The canvas itself cannot run under node, so every test here injects the
 * encoder and checks the decision around it: which types are re-encoded, what
 * is kept, what falls back to the input, and what happens when the browser
 * cannot encode WebP. The real canvas path is only taken where the browser
 * APIs exist, and a test below pins that node takes none of it.
 */

import { describe, expect, jest, test } from "@jest/globals";

import {
  compressPastedPicture,
  fitWithin,
  type PictureEncoder,
  type PictureForEncoding,
} from "../features/console/files/fileBrowser/compressPastedPicture";

function picture(contentType: string, size = 1000): PictureForEncoding {
  return { bytes: new Uint8Array(size).buffer, contentType };
}

function bytesOf(size: number): ArrayBuffer {
  return new Uint8Array(size).buffer;
}

describe("compressPastedPicture", () => {
  test("a PNG is re-encoded as WebP when the encoder's WebP is smaller", async () => {
    const input = picture("image/png", 1000);
    const encoder = jest.fn<PictureEncoder>(async () => ({ bytes: bytesOf(400), contentType: "image/webp" }));

    const result = await compressPastedPicture(input, encoder);

    expect(result.contentType).toBe("image/webp");
    expect(result.bytes.byteLength).toBe(400);
    expect(encoder).toHaveBeenCalledTimes(1);
    expect(encoder.mock.calls[0]?.[1].format).toBe("image/webp");
  });

  test("an encoded result that is not smaller than the input is discarded", async () => {
    const input = picture("image/jpeg", 1000);
    const encoder = jest.fn<PictureEncoder>(async () => ({ bytes: bytesOf(1000), contentType: "image/webp" }));

    const result = await compressPastedPicture(input, encoder);

    expect(result).toBe(input);
  });

  test("an encoder that throws leaves the input unchanged", async () => {
    const input = picture("image/png");
    const encoder = jest.fn<PictureEncoder>(async () => {
      throw new Error("canvas went away");
    });

    const result = await compressPastedPicture(input, encoder);

    expect(result).toBe(input);
  });

  test("a GIF, a HEIC and a sound are never encoded and come back as they went in", async () => {
    const encoder = jest.fn<PictureEncoder>(async () => ({ bytes: bytesOf(10), contentType: "image/webp" }));

    for (const contentType of ["image/gif", "image/heic", "audio/mpeg"]) {
      const input = picture(contentType);
      expect(await compressPastedPicture(input, encoder)).toBe(input);
    }
    expect(encoder).not.toHaveBeenCalled();
  });

  test("a WebP the browser cannot encode falls back to a JPEG on a white background", async () => {
    const input = picture("image/png", 1000);
    const encoder = jest.fn<PictureEncoder>(async (_picture, options) => {
      if (options.format === "image/webp") return { bytes: bytesOf(300), contentType: "image/png" };
      return { bytes: bytesOf(200), contentType: "image/jpeg" };
    });

    const result = await compressPastedPicture(input, encoder);

    expect(result.contentType).toBe("image/jpeg");
    expect(result.bytes.byteLength).toBe(200);
    expect(encoder).toHaveBeenCalledTimes(2);
    expect(encoder.mock.calls[1]?.[1].format).toBe("image/jpeg");
  });

  test("when neither WebP nor JPEG can be encoded the input is kept", async () => {
    const input = picture("image/webp", 1000);
    const encoder = jest.fn<PictureEncoder>(async () => ({ bytes: bytesOf(100), contentType: "image/png" }));

    expect(await compressPastedPicture(input, encoder)).toBe(input);
  });

  test("without a canvas to draw on, as on native, the input comes back untouched", async () => {
    const input = picture("image/png");

    expect(await compressPastedPicture(input)).toBe(input);
  });
});

describe("fitWithin", () => {
  test("scales the longest side down to the limit and keeps the aspect ratio", () => {
    expect(fitWithin(4000, 3000, 2560)).toEqual({ width: 2560, height: 1920 });
    expect(fitWithin(1000, 5000, 2560)).toEqual({ width: 512, height: 2560 });
  });

  test("never scales up", () => {
    expect(fitWithin(800, 600, 2560)).toEqual({ width: 800, height: 600 });
  });
});
