/**
 * A file that is not a note keeps its bytes and its type through a move, a
 * rename and a copy (project file `move-engine/plan.md`, step E).
 *
 * `movePath` and `copyPath` read every object with `text()` and wrote the
 * string back, so an image or PDF in a moved folder came out with each byte
 * that is not valid UTF-8 replaced, and stored as Markdown.
 *
 * Sabotage, each confirmed to fail a case here: put `text()` back in either
 * function, or drop the content type it carries.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { copyPath, movePath } from "../../functions/lib/fileOps";
import { NOW, bucket } from "./fixtures.helpers";

/** A JPEG header: 0xFF and 0xD8 are not valid UTF-8 on their own. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x80, 0xfe]);
const owner = clearanceOf("private");

function withPicture() {
  const store = bucket();
  store.seed("1-projects/trip/plan.md", "# Trip\n\n![](./photo.jpg)\n");
  return store;
}

async function seedPicture(store: ReturnType<typeof bucket>, key: string) {
  await store.put(key, JPEG, { contentType: "image/jpeg" });
}

function contentTypeOf(store: ReturnType<typeof bucket>, key: string) {
  return store.get(key).then((object) => object?.contentType ?? object?.httpMetadata?.contentType);
}

describe("a picture keeps its bytes and type", () => {
  test("moving the folder it is in", async () => {
    const store = withPicture();
    await seedPicture(store, "1-projects/trip/photo.jpg");
    await movePath(store, { from: "1-projects/trip", to: "2-areas/trip", clearance: owner, now: NOW });
    expect(store.bytesOf("2-areas/trip/photo.jpg")).toEqual(JPEG);
    expect(await contentTypeOf(store, "2-areas/trip/photo.jpg")).toBe("image/jpeg");
    expect(store.bytesOf("1-projects/trip/photo.jpg")).toBeNull();
  });

  test("renaming it", async () => {
    const store = withPicture();
    await seedPicture(store, "1-projects/trip/photo.jpg");
    await movePath(store, { from: "1-projects/trip/photo.jpg", to: "1-projects/trip/beach.jpg", clearance: owner, now: NOW });
    expect(store.bytesOf("1-projects/trip/beach.jpg")).toEqual(JPEG);
    expect(await contentTypeOf(store, "1-projects/trip/beach.jpg")).toBe("image/jpeg");
  });

  test("copying the folder it is in", async () => {
    const store = withPicture();
    await seedPicture(store, "1-projects/trip/photo.jpg");
    await copyPath(store, { from: "1-projects/trip", to: "1-projects/trip-copy", clearance: owner });
    expect(store.bytesOf("1-projects/trip-copy/photo.jpg")).toEqual(JPEG);
    expect(await contentTypeOf(store, "1-projects/trip-copy/photo.jpg")).toBe("image/jpeg");
    expect(store.bytesOf("1-projects/trip/photo.jpg")).toEqual(JPEG);
  });
});
