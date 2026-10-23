/**
 * A file that is not a note keeps its bytes and its type through a move, a
 * rename and a copy (project file `move-engine/plan.md`, step E).
 *
 * `movePath` and `copyPath` read every object with `text()` and wrote the
 * string back, so an image or PDF in a moved folder came out with each byte
 * that is not valid UTF-8 replaced, and stored as Markdown.
 *
 * Keyed workspace: a move is a row change, so a picture's bytes are not
 * rewritten at all; a copy writes the bytes through the id layer. Each case
 * reads the picture back through its row's key.
 *
 * Sabotage, each confirmed to fail a case here: put `text()` back in the copy
 * path, or drop the content type it carries.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { copyPath, movePath } from "../../functions/lib/fileOps";
import { NOW } from "./fixtures.helpers";
import { bytesAt, contentTypeAt, keyedBucket } from "./keyedFixture.fileops1.helpers";

/** A JPEG header: 0xFF and 0xD8 are not valid UTF-8 on their own. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x80, 0xfe]);
const owner = clearanceOf("private");

async function withPicture() {
  const f = await keyedBucket({ "1-projects/trip/plan.md": "# Trip\n\n![](./photo.jpg)\n" });
  await f.store.put("1-projects/trip/photo.jpg", JPEG, { contentType: "image/jpeg" });
  return f;
}

describe("a picture keeps its bytes and type", () => {
  test("moving the folder it is in", async () => {
    const f = await withPicture();
    await movePath(f.store, { from: "1-projects/trip", to: "2-areas/trip", clearance: owner, now: NOW });
    expect(await bytesAt(f, "2-areas/trip/photo.jpg")).toEqual(JPEG);
    expect(await contentTypeAt(f, "2-areas/trip/photo.jpg")).toBe("image/jpeg");
    expect(await bytesAt(f, "1-projects/trip/photo.jpg")).toBeNull();
  });

  test("renaming it", async () => {
    const f = await withPicture();
    await movePath(f.store, { from: "1-projects/trip/photo.jpg", to: "1-projects/trip/beach.jpg", clearance: owner, now: NOW });
    expect(await bytesAt(f, "1-projects/trip/beach.jpg")).toEqual(JPEG);
    expect(await contentTypeAt(f, "1-projects/trip/beach.jpg")).toBe("image/jpeg");
  });

  test("copying the folder it is in", async () => {
    const f = await withPicture();
    await copyPath(f.store, { from: "1-projects/trip", to: "1-projects/trip-copy", clearance: owner });
    expect(await bytesAt(f, "1-projects/trip-copy/photo.jpg")).toEqual(JPEG);
    expect(await contentTypeAt(f, "1-projects/trip-copy/photo.jpg")).toBe("image/jpeg");
    expect(await bytesAt(f, "1-projects/trip/photo.jpg")).toEqual(JPEG);
  });
});
