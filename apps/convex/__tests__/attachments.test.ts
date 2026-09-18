/**
 * A PASTED IMAGE IN A FOLDER THE CUSTOMER CAN SEE.
 *
 * There was already one image store — `IMAGE_PREFIX`, dot-prefixed, opaque,
 * holding pictures a machine produced. This is the other kind: something
 * somebody pasted into their own note, which has to resolve in Obsidian (which
 * skips dot-folders) and has to leave with them without an explanation about
 * where the pictures were hidden.
 *
 * What is pinned here:
 *
 *  1. **The name is derived, never supplied.** The key is the content hash, so
 *     the same paste twice is one object and a retry is idempotent.
 *  2. **The path gate is the whole security model of this pair.** It is what
 *     stops `attachments/../privacy.md` from being a general object reader, and
 *     every shape that has ever been tried against a path check is a case below.
 *  3. **The bytes survive.** Every byte value round-trips, so a stub that
 *     decodes to text cannot pass.
 */

import { describe, expect, test } from "vitest";

import {
  ATTACHMENT_PREFIX,
  MAX_STORED_IMAGE_BYTES,
  assertAttachmentPath,
  attachmentKeyFor,
  readAttachment,
  writeAttachment,
} from "../functions/lib/fileOps";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";

/** Every byte value, so a truncating or re-encoding stub cannot pass. */
const PNG_BYTES = new Uint8Array(512);
for (let i = 0; i < PNG_BYTES.length; i += 1) PNG_BYTES[i] = (i * 37 + 11) % 256;

const AT = new Date("2026-09-18T14:08:00Z");

function store(): MemoryStore {
  return memoryStore();
}

describe("the key is derived from the bytes", () => {
  test("date folders, a hash and the extension of the type", () => {
    expect(
      attachmentKeyFor({ hash: "4b2c9f1a3d5e7081", contentType: "image/png", at: AT }),
    ).toBe("attachments/2026/09/paste-4b2c9f1a3d5e7081.png");
  });

  test("jpeg is filed as jpg, because that is the extension the store serves", () => {
    expect(attachmentKeyFor({ hash: "4b2c9f1a", contentType: "image/jpeg", at: AT })).toBe(
      "attachments/2026/09/paste-4b2c9f1a.jpg",
    );
  });

  test("the month is two digits, so the folders sort", () => {
    const key = attachmentKeyFor({
      hash: "4b2c9f1a",
      contentType: "image/png",
      at: new Date("2026-01-02T00:00:00Z"),
    });
    expect(key).toBe("attachments/2026/01/paste-4b2c9f1a.png");
  });

  test("a hash longer than the name takes is truncated, not refused", () => {
    const key = attachmentKeyFor({
      hash: "0123456789abcdef0123456789abcdef",
      contentType: "image/png",
      at: AT,
    });
    expect(key).toBe("attachments/2026/09/paste-0123456789abcdef.png");
  });

  test("a type this store cannot serve has no key at all", () => {
    expect(() =>
      attachmentKeyFor({ hash: "4b2c9f1a", contentType: "image/svg+xml", at: AT }),
    ).toThrow();
    expect(() =>
      attachmentKeyFor({ hash: "4b2c9f1a", contentType: "text/html", at: AT }),
    ).toThrow();
  });

  test("a hash that is not a hash is refused rather than producing a junk name", () => {
    expect(() => attachmentKeyFor({ hash: "", contentType: "image/png", at: AT })).toThrow();
    expect(() =>
      attachmentKeyFor({ hash: "../../etc", contentType: "image/png", at: AT }),
    ).toThrow();
  });

  test("every derived key satisfies the gate that guards the store", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      const key = attachmentKeyFor({ hash: "4b2c9f1a3d5e7081", contentType: type, at: AT });
      expect(() => assertAttachmentPath(key)).not.toThrow();
    }
  });
});

describe("the path gate", () => {
  test("it accepts a key in the folder and nothing above it", () => {
    expect(assertAttachmentPath("attachments/2026/09/paste-abcd1234.png")).toBe(
      "paste-abcd1234.png",
    );
    expect(assertAttachmentPath("attachments/sketch.png")).toBe("sketch.png");
  });

  test("it refuses anything outside the folder", () => {
    expect(() => assertAttachmentPath("privacy.md")).toThrow();
    expect(() => assertAttachmentPath("1-projects/a.png")).toThrow();
    expect(() => assertAttachmentPath(".context/assets/images/a.png")).toThrow();
    expect(() => assertAttachmentPath("/attachments/a.png")).toThrow();
  });

  test("it refuses a traversal, in every spelling that has ever been tried", () => {
    expect(() => assertAttachmentPath("attachments/../privacy.md")).toThrow();
    expect(() => assertAttachmentPath("attachments/2026/../../privacy.md")).toThrow();
    expect(() => assertAttachmentPath("attachments/..%2Fprivacy.md")).toThrow();
    expect(() => assertAttachmentPath("attachments\\\\a.png")).toThrow();
  });

  test("it refuses a segment that would itself be plumbing", () => {
    expect(() => assertAttachmentPath("attachments/.hidden/a.png")).toThrow();
    expect(() => assertAttachmentPath("attachments/.a.png")).toThrow();
  });

  test("it refuses an extension the reader cannot answer for", () => {
    expect(() => assertAttachmentPath("attachments/a.svg")).toThrow();
    expect(() => assertAttachmentPath("attachments/a.md")).toThrow();
    expect(() => assertAttachmentPath("attachments/a")).toThrow();
    expect(() => assertAttachmentPath("attachments/png")).toThrow();
  });

  test("it refuses a tree deeper than filing needs, and a name longer than a name", () => {
    expect(() => assertAttachmentPath("attachments/a/b/c/d/e.png")).toThrow();
    expect(() => assertAttachmentPath(`attachments/${"a".repeat(240)}.png`)).toThrow();
  });

  test("the prefix is the visible folder, not a dot folder", () => {
    expect(ATTACHMENT_PREFIX.startsWith(".")).toBe(false);
    expect(ATTACHMENT_PREFIX).toBe("attachments/");
  });
});

describe("writing and reading the bytes", () => {
  test("every byte survives the round trip, with the type to serve it as", async () => {
    const memory = store();
    const key = attachmentKeyFor({ hash: "4b2c9f1a", contentType: "image/png", at: AT });
    const written = await writeAttachment(memory, {
      path: key,
      bytes: PNG_BYTES,
      contentType: "image/png",
    });
    expect(written.key).toBe(key);
    const read = await readAttachment(memory, key);
    expect(new Uint8Array(read.bytes)).toEqual(PNG_BYTES);
    expect(read.contentType).toBe("image/png");
  });

  test("the same bytes written twice are one object, not a conflict", async () => {
    const memory = store();
    const key = attachmentKeyFor({ hash: "4b2c9f1a", contentType: "image/png", at: AT });
    await writeAttachment(memory, { path: key, bytes: PNG_BYTES, contentType: "image/png" });
    await expect(
      writeAttachment(memory, { path: key, bytes: PNG_BYTES, contentType: "image/png" }),
    ).resolves.toMatchObject({ key });
  });

  test("nothing, and too much, are both refused", async () => {
    const memory = store();
    const key = attachmentKeyFor({ hash: "4b2c9f1a", contentType: "image/png", at: AT });
    await expect(
      writeAttachment(memory, {
        path: key,
        bytes: new Uint8Array(0),
        contentType: "image/png",
      }),
    ).rejects.toThrow();
    await expect(
      writeAttachment(memory, {
        path: key,
        bytes: new Uint8Array(MAX_STORED_IMAGE_BYTES + 1),
        contentType: "image/png",
      }),
    ).rejects.toThrow();
  });

  test("a content type outside the set never reaches the store", async () => {
    const memory = store();
    await expect(
      writeAttachment(memory, {
        path: "attachments/a.png",
        bytes: PNG_BYTES,
        contentType: "text/html",
      }),
    ).rejects.toThrow();
    expect([...memory.objects.keys()]).toEqual([]);
  });

  test("a write outside the folder never happens", async () => {
    const memory = store();
    await expect(
      writeAttachment(memory, {
        path: "privacy.md",
        bytes: PNG_BYTES,
        contentType: "image/png",
      }),
    ).rejects.toThrow();
    expect([...memory.objects.keys()]).toEqual([]);
  });

  test("a read of something that is not there is the same absence as a read of something forbidden", async () => {
    const memory = store();
    await expect(
      readAttachment(memory, "attachments/2026/09/paste-ffff.png"),
    ).rejects.toThrow(/does not exist/i);
    await expect(readAttachment(memory, "attachments/../privacy.md")).rejects.toThrow();
  });
});
