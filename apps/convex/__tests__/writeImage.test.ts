/**
 * WRITING SOMETHING THAT IS NOT A NOTE.
 *
 * Until now every write in this product put markdown at a `.md` key, and the S3
 * adapter hardcoded `content-type: text/markdown; charset=utf-8` to match. This
 * is the other half of the images feature: it can already *serve* bytes
 * (`read_image` in the gateway) and had no way to put any there.
 *
 * Three properties, and the first is the one with teeth:
 *
 *  1. **The content type is an enumeration, never free text.** It lands in an
 *     S3 request header, so a caller-chosen string is header injection by the
 *     same route `assertSafeEtag` exists to close. An allow-list means there is
 *     no string that reaches the header at all.
 *  2. **A stored object is not a note**, and is deliberately exempt from the
 *     rules that make a note a note — no `.md`, no visibility of its own, no
 *     history, no conditional write. Each exemption is a decision with a
 *     reason, asserted here so it cannot be quietly reversed into "writeFile
 *     with a flag".
 *  3. **The bytes survive.** Both in-memory stubs used to decode every
 *     non-string `put` to text and re-encode it — lossless for markdown,
 *     silently corrupting for a PNG, and invisible to any test that read it
 *     back through the same decode. Fixed alongside this; the round-trip check
 *     below is what keeps it fixed.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { describe, expect, test } from "vitest";
import {
  IMAGE_PREFIX,
  MAX_STORED_IMAGE_BYTES,
  STORABLE_IMAGE_EXTENSIONS,
  writeImage,
  type FileStore,
} from "../functions/lib/fileOps";
import {
  assertWritableContentType,
  MARKDOWN_CONTENT_TYPE,
  WRITABLE_CONTENT_TYPES,
} from "../../mcp/src/store/index.js";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";

/** Every byte value, so a truncating or re-encoding stub cannot pass. */
const PNG_BYTES = new Uint8Array(512);
for (let i = 0; i < PNG_BYTES.length; i += 1) PNG_BYTES[i] = (i * 37 + 11) % 256;

function store(): MemoryStore {
  return memoryStore();
}

describe("the content type is an allow-list", () => {
  test("absent means markdown, which is what every earlier write meant", () => {
    expect(assertWritableContentType(undefined)).toBe(MARKDOWN_CONTENT_TYPE);
    expect(assertWritableContentType(null)).toBe(MARKDOWN_CONTENT_TYPE);
  });

  test("the image types the gateway can serve back are accepted", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(assertWritableContentType(type)).toBe(type);
    }
  });

  /**
   * THE test. Anything not in the set is refused rather than sanitised — a
   * sanitiser is a guess about a header grammar, and every guess here is a
   * request an attacker gets to rewrite.
   */
  test.each([
    ["text/html", "a type that renders"],
    ["application/javascript", "a type that executes"],
    ["image/png\r\nx-injected: 1", "a CRLF header injection"],
    ["image/png; charset=\"", "an unbalanced quote"],
    ["", "empty"],
    ["*/*", "a wildcard"],
  ])("%s is refused (%s)", (type) => {
    expect(() => assertWritableContentType(type)).toThrow(/unsupported content type/);
  });

  test("a non-string is refused rather than coerced", () => {
    expect(() => assertWritableContentType(42 as unknown as string)).toThrow();
    expect(() => assertWritableContentType({} as unknown as string)).toThrow();
  });

  /**
   * SVG is absent from the write allow-list for the same reason it is absent
   * from the gateway's read map: it is a script container. A store that would
   * accept one makes the gateway's refusal moot — the bytes would simply sit
   * there, unreadable by us and readable by anything else pointed at the
   * bucket.
   */
  test("SVG is not writable, matching the gateway's refusal to serve it", () => {
    expect(WRITABLE_CONTENT_TYPES.has("image/svg+xml")).toBe(false);
    expect(() => assertWritableContentType("image/svg+xml")).toThrow();
  });
});

describe("writing an image", () => {
  test("lands in the opaque store under the leaf it was given", async () => {
    const s = store();
    const result = await writeImage(s as unknown as FileStore, {
      leaf: "abc123.png",
      bytes: PNG_BYTES,
      contentType: "image/png",
    });

    expect(result.key).toBe(`${IMAGE_PREFIX}abc123.png`);
    expect(result.etag).toBeTruthy();
  });

  /**
   * The round trip that the old stubs could not have failed. Comparing decoded
   * text would pass against a stub that mangled the bytes, because the
   * assertion and the corruption shared one decode.
   */
  test("the bytes survive exactly", async () => {
    const s = store();
    await writeImage(s as unknown as FileStore, {
      leaf: "abc123.png",
      bytes: PNG_BYTES,
      contentType: "image/png",
    });

    const stored = s.bytesOf(`${IMAGE_PREFIX}abc123.png`);
    expect(stored).not.toBeNull();
    expect([...stored!]).toEqual([...PNG_BYTES]);
  });

  test("writes no history entry, because a content-addressed key has no previous version", async () => {
    const s = store();
    await writeImage(s as unknown as FileStore, {
      leaf: "abc123.png",
      bytes: PNG_BYTES,
      contentType: "image/png",
    });
    await writeImage(s as unknown as FileStore, {
      leaf: "abc123.png",
      bytes: PNG_BYTES,
      contentType: "image/png",
    });

    expect(Object.keys(s.snapshot()).filter((key) => key.startsWith(".history/"))).toEqual(
      [],
    );
  });

  /**
   * No `privacy.md` is seeded in this store at all. `writeFile` would refuse
   * outright — a missing manifest fails closed and every note reads private.
   * An image has no visibility of its own, so it must not consult one.
   */
  test("does not consult the access map, because an image has no visibility of its own", async () => {
    const s = store();
    expect(s.snapshot()["privacy.md"]).toBeUndefined();

    await expect(
      writeImage(s as unknown as FileStore, {
        leaf: "abc123.png",
        bytes: PNG_BYTES,
        contentType: "image/png",
      }),
    ).resolves.toBeTruthy();
  });
});

describe("what a leaf may be", () => {
  const write = (leaf: string) =>
    writeImage(store() as unknown as FileStore, {
      leaf,
      bytes: PNG_BYTES,
      contentType: "image/png",
    });

  /**
   * The gateway's own rule, restated. A key this writes that `read_image`
   * cannot name is bytes nobody can ever get back out — so the two must agree,
   * and `apps/mcp` being dependency-free means they cannot share a module.
   */
  test.each([
    ["../privacy.md", "traversal"],
    ["nested/thing.png", "a second segment"],
    [".hidden.png", "leading dot — the leaf would itself be plumbing"],
    ["", "empty"],
    ["a b.png", "a space"],
    ["a\u0000b.png", "a control character"],
    [`${"a".repeat(201)}.png`, "longer than the cap"],
  ])("%s is refused (%s)", async (leaf) => {
    await expect(write(leaf)).rejects.toThrow();
  });


  /**
   * The gates of "the gateway's own rule" that were not restated.
   *
   * `imageRefFor` refuses `..` outright, then requires the character class,
   * then `lastIndexOf(".") > 0`, then an extension in `IMAGE_MIME_TYPES`. This
   * function enforced the character class alone. Each leaf below names an
   * object `read_image` refuses forever — precisely the outcome the doc comment
   * on `writeImage` says it exists to prevent.
   *
   * (`.png` is the one member that the character class already refused; it is
   * kept because it is the boundary of `dot <= 0` from the other side. An
   * earlier version of this docstring claimed every leaf below satisfied the
   * old rule, which was false for exactly that one.)
   */
  test.each([
    ["abc", "no extension at all"],
    ["abc.txt", "an extension the gateway will not serve"],
    ["abc.svg", "SVG — deliberately absent from the gateway's map"],
    ["abc.", "a trailing dot and nothing after it"],
    [".png", "the dot first, so there is no name"],
    // `imageRefFor`'s FOURTH gate, which a review found still open after the
    // other three were closed: `raw.includes("..")`. It survives the character
    // class, because `.` is in that class, and the extension lookup, because
    // `png` is servable. Measured before the fix — both of these RESOLVED and
    // wrote bytes under keys `read_image` refuses forever.
    ["a..png", "a doubled dot, which the gateway refuses outright"],
    ["abc..jpeg", "the same, with a servable extension after it"],
    // And the `dot <= 0` gate, which nothing pinned: sabotaging it alone left
    // all 37 checks green. It is reachable, not a backstop — without it
    // `slice(-1 + 1)` is the whole leaf, so a leaf that IS an extension name
    // passes the set lookup and writes `.context/assets/images/png`.
    ["png", "a leaf that is only an extension name, so there is no dot"],
    ["jpeg", "the same, with the other spelling"],
  ])("%s is refused (%s)", async (leaf) => {
    await expect(write(leaf)).rejects.toThrow();
  });

  test.each(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"])(
    "a .%s leaf is accepted, so this is not a blanket refusal",
    async (extension) => {
      await expect(write(`${"a".repeat(64)}.${extension}`)).resolves.toBeTruthy();
    },
  );

  /**
   * The drift check `writeImage`'s doc claims — and did not have.
   *
   * Its comment said "a test reads the gateway's source and fails on drift —
   * the same arrangement `MAX_INLINE_IMAGE_BYTES` already has". That
   * arrangement did exist for the byte constant
   * (`ingestionGateway.test.ts`), and for the email worker's own type map
   * (`infra/email-worker/src/ingest.test.ts`). It did not exist here: the
   * tests above this one were literals, so a change to the gateway's map
   * would have left every one of them green. Two of three copies were pinned
   * and the third only said it was.
   */
  test("the accepted extensions are the gateway's, read from its source", () => {
    const gateway = readFileSync(
      resolvePath(__dirname, "../../mcp/src/index.js"),
      "utf8",
    );
    const block = gateway.match(/const IMAGE_MIME_TYPES = new Map\(\[([\s\S]*?)\]\);/);
    expect(block, "IMAGE_MIME_TYPES is no longer declared in apps/mcp").not.toBeNull();
    const servable = new Set(
      [...block![1]!.matchAll(/\["([a-z0-9]+)",/g)].map((m) => m[1]!),
    );

    expect(servable.size).toBeGreaterThan(0);
    expect([...STORABLE_IMAGE_EXTENSIONS].sort()).toEqual([...servable].sort());
  });
});

describe("size", () => {
  test("an empty object is refused rather than stored", async () => {
    await expect(
      writeImage(store() as unknown as FileStore, {
        leaf: "abc.png",
        bytes: new Uint8Array(0),
        contentType: "image/png",
      }),
    ).rejects.toThrow(/nothing to store/);
  });

  test("anything past the ceiling is refused", async () => {
    await expect(
      writeImage(store() as unknown as FileStore, {
        leaf: "abc.png",
        bytes: new Uint8Array(MAX_STORED_IMAGE_BYTES + 1),
        contentType: "image/png",
      }),
    ).rejects.toThrow(/at most/);
  });

  /**
   * Its own number, not `MAX_NOTE_BYTES`. They happen to be close and mean
   * different things — one bounds a document a person typed, the other bounds
   * bytes a machine produced — and sharing a constant means changing the note
   * limit silently changes what a bucket may be made to hold.
   */
  test("the image ceiling is independent of the note ceiling", async () => {
    const { MAX_NOTE_BYTES } = await import("../functions/lib/fileOps");
    expect(MAX_STORED_IMAGE_BYTES).not.toBe(MAX_NOTE_BYTES);
  });
});
