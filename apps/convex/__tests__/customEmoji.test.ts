/**
 * A workspace's own emoji, against a bucket.
 *
 * The object's name is the record (`emoji-<name>.<ext>` in the image store),
 * so what has to hold is about names: the bytes decide the extension, one
 * name is one picture, a name can never build a leaf outside the store, and a
 * listing of emoji never surfaces anything else in the store.
 */

import { describe, expect, test } from "vitest";
import {
  customEmojiLeaf,
  customEmojiNameFrom,
  findShortcodes,
  parseCustomEmojiLeaf,
} from "@context/shared/src/customEmoji";
import {
  IMAGE_PREFIX,
  listCustomEmoji,
  readCustomEmoji,
  removeCustomEmoji,
  renameCustomEmoji,
  storeCustomEmoji,
  writeImage,
} from "../functions/lib/fileOps";
import { memoryStore } from "./storeStub.helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const GIF = new TextEncoder().encode("GIF89a-animated-bytes");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("names and leaves", () => {
  test("a leaf is the name and the type's extension", () => {
    expect(customEmojiLeaf("partyparrot", "image/gif")).toBe("emoji-partyparrot.gif");
    expect(customEmojiLeaf("ship_it-2", "image/jpeg")).toBe("emoji-ship_it-2.jpg");
    expect(parseCustomEmojiLeaf("emoji-partyparrot.gif")).toEqual({ name: "partyparrot", extension: "gif" });
  });

  test.each(["", "Party", "../privacy", "a/b", "-lead", "a.b", "a b", "x".repeat(65)])(
    "%j is not a name",
    (name) => {
      expect(customEmojiLeaf(name, "image/png")).toBeNull();
    },
  );

  test("SVG and HEIC have no leaf", () => {
    expect(customEmojiLeaf("x", "image/svg+xml")).toBeNull();
    expect(customEmojiLeaf("x", "image/heic")).toBeNull();
  });

  test("other objects in the store are not emoji", () => {
    expect(parseCustomEmojiLeaf("paste-4b2c9f1a3d5e7081.png")).toBeNull();
    expect(parseCustomEmojiLeaf("emoji-.png")).toBeNull();
    expect(parseCustomEmojiLeaf("emoji-x.svg")).toBeNull();
  });

  test("a file name becomes a name", () => {
    expect(customEmojiNameFrom("Party Parrot.gif")).toBe("party-parrot");
    expect(customEmojiNameFrom("__api__.png")).toBe("api__");
    expect(customEmojiNameFrom("😀.png")).toBe("");
  });

  test("shortcodes are found only where they stand alone", () => {
    expect(findShortcodes("ship it :partyparrot: now :+1:").map((hit) => hit.name)).toEqual(["partyparrot", "+1"]);
    expect(findShortcodes("at 10:30:45, http://x, a::b::c, x:tada:")).toEqual([]);
    const [hit] = findShortcodes("(:tada:)");
    expect(hit).toEqual({ from: 1, to: 7, name: "tada" });
  });
});

describe("the store", () => {
  test("stores under a leaf the bytes chose, and reads it back by name", async () => {
    const store = memoryStore();
    expect(await storeCustomEmoji(store, { name: "parrot", bytes: GIF, replace: false })).toEqual({
      name: "parrot",
      leaf: "emoji-parrot.gif",
    });
    const read = await readCustomEmoji(store, "parrot");
    expect(read.contentType).toBe("image/gif");
    expect(new Uint8Array(read.bytes)).toEqual(GIF);
  });

  test("an SVG, or anything that is not an image, is refused", async () => {
    const store = memoryStore();
    expect(await codeOf(storeCustomEmoji(store, { name: "x", bytes: SVG, replace: false }))).toBe("PATH_INVALID");
    expect(await listCustomEmoji(store)).toEqual([]);
  });

  test("a name that is taken is refused unless replacing, and a replacement leaves one picture", async () => {
    const store = memoryStore();
    await storeCustomEmoji(store, { name: "api", bytes: PNG, replace: false });
    expect(await codeOf(storeCustomEmoji(store, { name: "api", bytes: GIF, replace: false }))).toBe(
      "DESTINATION_EXISTS",
    );
    await storeCustomEmoji(store, { name: "api", bytes: GIF, replace: true });
    expect(await listCustomEmoji(store)).toEqual([{ name: "api", leaf: "emoji-api.gif" }]);
    expect(await store.get(`${IMAGE_PREFIX}emoji-api.png`)).toBeNull();
  });

  test("the listing is emoji only: pastes and icons in the same store never appear", async () => {
    const store = memoryStore();
    await writeImage(store, { leaf: "paste-4b2c9f1a3d5e7081.png", bytes: PNG, contentType: "image/png" });
    await writeImage(store, { leaf: "icon-4b2c9f1a3d5e7081.png", bytes: PNG, contentType: "image/png" });
    await storeCustomEmoji(store, { name: "lgtm", bytes: PNG, replace: false });
    await storeCustomEmoji(store, { name: "ship", bytes: GIF, replace: false });
    expect(await listCustomEmoji(store)).toEqual([
      { name: "lgtm", leaf: "emoji-lgtm.png" },
      { name: "ship", leaf: "emoji-ship.gif" },
    ]);
  });

  test("reading by name cannot reach another object", async () => {
    const store = memoryStore();
    await writeImage(store, { leaf: "paste-4b2c9f1a3d5e7081.png", bytes: PNG, contentType: "image/png" });
    for (const name of ["../paste-4b2c9f1a3d5e7081.png", "paste-4b2c9f1a3d5e7081", "x/../../privacy"]) {
      expect(await codeOf(readCustomEmoji(store, name))).toBe("FILE_NOT_FOUND");
    }
  });

  test("rename moves the picture; remove takes it away", async () => {
    const store = memoryStore();
    await storeCustomEmoji(store, { name: "old", bytes: PNG, replace: false });
    await storeCustomEmoji(store, { name: "taken", bytes: PNG, replace: false });
    expect(await codeOf(renameCustomEmoji(store, { from: "old", to: "taken" }))).toBe("DESTINATION_EXISTS");
    await renameCustomEmoji(store, { from: "old", to: "new" });
    expect((await listCustomEmoji(store)).map((emoji) => emoji.name)).toEqual(["new", "taken"]);
    await removeCustomEmoji(store, "new");
    expect((await listCustomEmoji(store)).map((emoji) => emoji.name)).toEqual(["taken"]);
    expect(await codeOf(removeCustomEmoji(store, "new"))).toBe("FILE_NOT_FOUND");
  });
});
