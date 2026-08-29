import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import { toFileError } from "../features/console/files/browser";

/**
 * **What a thrown thing is allowed to say on somebody's screen.**
 *
 * `toFileError` is the single funnel between anything the file actions throw
 * and the copy the console renders — six call sites in `useFileBrowser`, and
 * every notice, save failure and toast comes through it. Nothing tested it.
 *
 * The rule it enforces is the one `console/failure.ts` states in its own
 * header: *"never a raw runtime string as the headline — that is how a stack
 * trace ends up in a screenshot."* Only a `ConvexError` shaped by the server —
 * `FileOpError`, whose message may name a path and may never carry note
 * content, a credential or a provider's raw response — reaches a person. A
 * plain `Error` is replaced wholesale.
 *
 * That matters here more than in most consoles: the thing on the other side of
 * these actions is a **customer-configured storage endpoint**, reached with a
 * decrypted credential. An adapter throw can carry a bucket name, a host, a
 * signed URL or a provider's XML. The server is careful about what it puts in a
 * `FileOpError`; this is the guard for everything that is not one.
 */
describe("toFileError", () => {
  const MARKER = "s3.example.invalid/bucket-9f3?X-Amz-Signature=deadbeef";

  test("a raw Error never reaches the screen, whatever it is carrying", () => {
    for (const thrown of [
      new Error(MARKER),
      new TypeError(MARKER),
      MARKER,
      { message: MARKER },
      { data: MARKER },
      null,
      undefined,
    ]) {
      const shown = toFileError(thrown);
      expect(shown.message).not.toContain("example.invalid");
      expect(shown.message).not.toContain("X-Amz-Signature");
      expect(shown.code).toBe("UNKNOWN");
    }
  });

  test("a ConvexError the server shaped does reach it", () => {
    // The other half, and the reason this is not just "return a constant": a
    // refusal a person can act on — "That folder already exists" — has to
    // survive, or every failure becomes an unhelpful shrug.
    const shown = toFileError(
      new ConvexError({ code: "DESTINATION_EXISTS", message: "Something already exists there." }),
    );
    expect(shown).toEqual({
      code: "DESTINATION_EXISTS",
      message: "Something already exists there.",
      currentEtag: undefined,
    });
  });

  test("a non-string code is replaced, not passed through", () => {
    // The `code` narrowing was unheld: swapping it for a cast passed all 1506.
    // It matters because `code` is branched on — `refresh` drops a listing on
    // `FILE_NOT_FOUND` — so a payload whose `code` is not a string must not
    // reach that comparison wearing whatever type it arrived as.
    const shown = toFileError(
      new ConvexError({ code: { toString: () => "FILE_NOT_FOUND" }, message: "gone" } as never),
    );
    expect(shown.code).toBe("UNKNOWN");
    expect(typeof shown.code).toBe("string");
  });

  test("a conflict carries its etag, and only when it is a string", () => {
    expect(
      toFileError(new ConvexError({ code: "CONFLICT", message: "Someone else saved.", currentEtag: "e7" }))
        .currentEtag,
    ).toBe("e7");
    expect(
      toFileError(new ConvexError({ code: "CONFLICT", message: "Someone else saved.", currentEtag: 7 }))
        .currentEtag,
    ).toBeUndefined();
  });

  test("a ConvexError whose payload is not shaped is treated as raw", () => {
    // A `ConvexError` carrying a bare string, or an object with no string
    // `message`, is not something the file layer produced. Reading it anyway is
    // how a guard that checks the wrapper rather than the contents leaks.
    for (const thrown of [
      new ConvexError(MARKER),
      new ConvexError({ code: "X", message: 42 } as never),
      new ConvexError({ code: "X" } as never),
    ]) {
      const shown = toFileError(thrown);
      expect(shown.message).not.toContain("example.invalid");
      expect(shown.code).toBe("UNKNOWN");
    }
  });
});
