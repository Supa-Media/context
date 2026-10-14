/**
 * A workspace's own emoji, against a bucket.
 *
 * The picture is the object `emoji-<name>.<ext>` in the image store; its name
 * and leaf are held in Convex (`files/smallData.test.ts`). What has to hold
 * here: the bytes decide the extension, one name is one picture, a leaf a row
 * holds can never reach anything but that name's own picture, and the
 * listing the import reads never surfaces anything else in the store.
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
  test("stores under a leaf the bytes chose, and reads it back by that leaf", async () => {
    const store = memoryStore();
    expect(await storeCustomEmoji(store, { name: "parrot", bytes: GIF, previous: null })).toEqual({
      name: "parrot",
      leaf: "emoji-parrot.gif",
    });
    const read = await readCustomEmoji(store, { name: "parrot", leaf: "emoji-parrot.gif" });
    expect(read.contentType).toBe("image/gif");
    expect(new Uint8Array(read.bytes)).toEqual(GIF);
  });

  test("an SVG, or anything that is not an image, is refused", async () => {
    const store = memoryStore();
    expect(await codeOf(storeCustomEmoji(store, { name: "x", bytes: SVG, previous: null }))).toBe("PATH_INVALID");
    expect(await listCustomEmoji(store)).toEqual([]);
  });

  test("a replacement of another type leaves one picture", async () => {
    const store = memoryStore();
    await storeCustomEmoji(store, { name: "api", bytes: PNG, previous: null });
    await storeCustomEmoji(store, { name: "api", bytes: GIF, previous: "emoji-api.png" });
    expect(await listCustomEmoji(store)).toEqual([{ name: "api", leaf: "emoji-api.gif" }]);
    expect(await store.get(`${IMAGE_PREFIX}emoji-api.png`)).toBeNull();
  });

  test("a previous leaf that is not this name's own is refused before anything is written", async () => {
    const store = memoryStore();
    await writeImage(store, { leaf: "paste-4b2c9f1a3d5e7081.png", bytes: PNG, contentType: "image/png" });
    for (const previous of ["paste-4b2c9f1a3d5e7081.png", "emoji-other.png", "../privacy.md"]) {
      expect(await codeOf(storeCustomEmoji(store, { name: "api", bytes: GIF, previous }))).toBe("FILE_NOT_FOUND");
    }
    expect(await store.get(`${IMAGE_PREFIX}paste-4b2c9f1a3d5e7081.png`)).not.toBeNull();
    expect(await listCustomEmoji(store)).toEqual([]);
  });

  test("the listing the import reads is emoji only: pastes and icons in the same store never appear", async () => {
    const store = memoryStore();
    await writeImage(store, { leaf: "paste-4b2c9f1a3d5e7081.png", bytes: PNG, contentType: "image/png" });
    await writeImage(store, { leaf: "icon-4b2c9f1a3d5e7081.png", bytes: PNG, contentType: "image/png" });
    await storeCustomEmoji(store, { name: "lgtm", bytes: PNG, previous: null });
    await storeCustomEmoji(store, { name: "ship", bytes: GIF, previous: null });
    expect(await listCustomEmoji(store)).toEqual([
      { name: "lgtm", leaf: "emoji-lgtm.png" },
      { name: "ship", leaf: "emoji-ship.gif" },
    ]);
  });

  test("a leaf held for a name cannot reach another object", async () => {
    const store = memoryStore();
    await writeImage(store, { leaf: "paste-4b2c9f1a3d5e7081.png", bytes: PNG, contentType: "image/png" });
    const tries: Array<{ name: string; leaf: string }> = [
      { name: "x", leaf: "paste-4b2c9f1a3d5e7081.png" },
      { name: "../paste-4b2c9f1a3d5e7081.png", leaf: "emoji-x.png" },
      { name: "x", leaf: "emoji-y.png" },
      { name: "x", leaf: "emoji-x.png/../../privacy.md" },
    ];
    for (const held of tries) {
      expect(await codeOf(readCustomEmoji(store, held))).toBe("FILE_NOT_FOUND");
      expect(await codeOf(removeCustomEmoji(store, held))).toMatch(/FILE_NOT_FOUND|PATH_INVALID/);
    }
    expect(await store.get(`${IMAGE_PREFIX}paste-4b2c9f1a3d5e7081.png`)).not.toBeNull();
  });

  test("rename moves the picture; remove takes it away", async () => {
    const store = memoryStore();
    await storeCustomEmoji(store, { name: "old", bytes: PNG, previous: null });
    await renameCustomEmoji(store, { from: "old", to: "new", leaf: "emoji-old.png" });
    expect((await listCustomEmoji(store)).map((emoji) => emoji.name)).toEqual(["new"]);
    await removeCustomEmoji(store, { name: "new", leaf: "emoji-new.png" });
    expect(await listCustomEmoji(store)).toEqual([]);
  });
});
