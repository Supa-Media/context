/**
 * THE NAME A PASTED IMAGE IS STORED UNDER.
 *
 * It goes in the opaque store — `IMAGE_PREFIX`, dot-prefixed and unlistable —
 * with the share cards and the inline images off an email, which reverses the
 * first version of this feature and is the owner's call: one image store rather
 * than two, nothing new in the file tree, and `read_image` already serves this
 * prefix, so an agent can fetch a pasted image.
 *
 * What is pinned here is the one thing this adds to a store that already
 * existed: the name. It is derived from the bytes and never supplied, and every
 * name it can produce has to satisfy `writeImage`'s leaf rule — a key that rule
 * refuses is bytes nobody can ever get back out, and a key it accepts that
 * `read_image` refuses is the same thing one layer up.
 */

import { describe, expect, test } from "vitest";

import { IMAGE_PREFIX, pasteImageLeaf, writeImage } from "../functions/lib/fileOps";
import { memoryStore } from "./storeStub.helpers";

/** Every byte value, so a truncating or re-encoding stub cannot pass. */
const PNG_BYTES = new Uint8Array(512);
for (let i = 0; i < PNG_BYTES.length; i += 1) PNG_BYTES[i] = (i * 37 + 11) % 256;

const HASH = "4b2c9f1a3d5e7081";

describe("the leaf is derived from the bytes", () => {
  test("the hash names the object, with the extension of the type", () => {
    expect(pasteImageLeaf({ hash: HASH, contentType: "image/png" })).toBe(
      "paste-4b2c9f1a3d5e7081.png",
    );
  });

  test("jpeg is filed as jpg, because that is what the gateway serves", () => {
    expect(pasteImageLeaf({ hash: HASH, contentType: "image/jpeg" })).toBe(
      "paste-4b2c9f1a3d5e7081.jpg",
    );
  });

  test("a longer digest is truncated rather than refused", () => {
    expect(
      pasteImageLeaf({ hash: "0123456789abcdef0123456789abcdef", contentType: "image/png" }),
    ).toBe("paste-0123456789abcdef.png");
  });

  test("a type this store cannot serve has no name at all", () => {
    expect(() => pasteImageLeaf({ hash: HASH, contentType: "image/svg+xml" })).toThrow();
    expect(() => pasteImageLeaf({ hash: HASH, contentType: "text/html" })).toThrow();
  });

  test("a hash that is not a hash is refused rather than producing a junk name", () => {
    expect(() => pasteImageLeaf({ hash: "", contentType: "image/png" })).toThrow();
    expect(() => pasteImageLeaf({ hash: "../../etc", contentType: "image/png" })).toThrow();
    expect(() => pasteImageLeaf({ hash: "zz", contentType: "image/png" })).toThrow();
  });
});

describe("every name it produces is one the store accepts", () => {
  test("each type round-trips through writeImage into the opaque prefix", async () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      const store = memoryStore();
      const leaf = pasteImageLeaf({ hash: HASH, contentType: type });
      const written = await writeImage(store, { leaf, bytes: PNG_BYTES, contentType: type });
      expect(written.key).toBe(`${IMAGE_PREFIX}${leaf}`);
      expect(store.bytesOf(written.key)).toEqual(PNG_BYTES);
    }
  });

  test("the store it lands in is the hidden one, which is what makes it plumbing", () => {
    expect(IMAGE_PREFIX.startsWith(".")).toBe(true);
    const leaf = pasteImageLeaf({ hash: HASH, contentType: "image/png" });
    // One segment, alphanumeric first: `writeImage`'s rule, restated as the
    // property this derivation must never break.
    expect(leaf.includes("/")).toBe(false);
    expect(/^[A-Za-z0-9]/.test(leaf)).toBe(true);
  });

  test("the same bytes twice are the same object", async () => {
    const store = memoryStore();
    const leaf = pasteImageLeaf({ hash: HASH, contentType: "image/png" });
    await writeImage(store, { leaf, bytes: PNG_BYTES, contentType: "image/png" });
    await writeImage(store, { leaf, bytes: PNG_BYTES, contentType: "image/png" });
    expect([...store.objects.keys()].filter((key) => key.includes("paste-")).length).toBe(1);
  });
});
