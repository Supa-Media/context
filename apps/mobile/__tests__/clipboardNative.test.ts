import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * The native clipboard, which its own docblock says nothing runs.
 *
 * `clipboard.ts` states it plainly — *"**Nothing in `pnpm test` runs this
 * file**, and that is worth knowing rather than assuming a green suite covered
 * it"* — and then names what stands in for a test: the dependency's type,
 * *"`setStringAsync` answers `Promise<boolean>`, which is why the line below
 * returns it"*. A type is not a test. It cannot tell `return await
 * Clipboard.setStringAsync(text)` from `await Clipboard.setStringAsync(text);
 * return true`, and the difference between those two lines is the whole of what
 * this file is careful about.
 *
 * ## The stance being pinned, in the file's own words
 *
 * > **Returned, not discarded.** `setStringAsync` answers whether the copy
 * > actually happened. `await …; return true` reads as correct and turns a
 * > `false` into a claimed copy — the exact "small lie nobody forgives" this
 * > file has warned about since it was a stub, and an invisible one: the dialog
 * > would close and say "Link copied" over an empty clipboard.
 *
 * That is a **failure-stance decision**, which is the category that has been
 * wrong before in this app: the offline key/value port's `keys()` had a read's
 * stance and a clear's callers, and a sign-out reported that it had cleared a
 * device it could not read. Two of these four lines are the same kind of
 * decision, on the surface that tells somebody whether their note text left the
 * app.
 *
 * And the callers do read the answer rather than assume it — `MeetingNoteScreen`
 * takes `const ok = await writeClipboard(...)` and says *"Said, never
 * assumed"*, `copyController` drives the Copy → Copied label off it. A `true`
 * that is not true propagates straight to a person.
 *
 * ## Measured by sabotage
 *
 * | break | reddens |
 * | --- | --- |
 * | `await setStringAsync(text); return true` | **2** |
 * | drop the `catch`, let a throw escape | **1** |
 * | `copyDeferred` writes `value ?? ""` instead of declining | **1** |
 *
 * The first is 2 rather than the 1 it looks like, because `copyDeferred` reads
 * the same answer: a `writeClipboard` that always says yes also makes the
 * deferred copy claim a refused write succeeded. Predicted 1, measured 2, and
 * the number here is the measurement.
 *
 * **Every one of them was 0 before this file**, because nothing imported it:
 * with both stances broken at once, the pre-existing suite is 325 suites and
 * 6,186 tests, fully green.
 *
 * The third break has a twin in the web half that was a live defect rather
 * than a hypothetical — see `copyShareLink.test.ts`.
 */

/**
 * `mock`-prefixed because the factory below reads them, and jest refuses any
 * other out-of-scope name — the arrangement `offlineStoreNative.test.ts` makes.
 */
let mockWritten: string[];
let mockAnswer: boolean;
let mockThrows: boolean;

jest.mock("expo-clipboard", () => ({
  __esModule: true,
  setStringAsync: async (text: string) => {
    if (mockThrows) throw new Error("the clipboard is not available");
    // Only record when the OS says it took it — a refusal leaves the clipboard
    // holding whatever it held, which is the property the null case turns on.
    if (mockAnswer) mockWritten.push(text);
    return mockAnswer;
  },
}));

/** By explicit path: a bare import is the web half, which has its own suite. */
const { writeClipboard, copyDeferred } =
  require("../features/design/clipboard.ts") as typeof import("../features/design/clipboard");

beforeEach(() => {
  mockWritten = [];
  mockAnswer = true;
  mockThrows = false;
});

describe("the native clipboard never claims a copy it did not make", () => {
  test("a copy the system took is reported as taken, with the text intact", async () => {
    expect(await writeClipboard("https://context.lc/s/abc")).toBe(true);
    expect(mockWritten).toEqual(["https://context.lc/s/abc"]);
  });

  test("AND A COPY THE SYSTEM REFUSED IS REPORTED AS REFUSED", async () => {
    /*
      The one the docblock is about. `setStringAsync` resolving `false` is a
      copy that did not happen, and the single most tempting edit to this file
      — `await …; return true`, which reads as correct — converts it into
      "Link copied" over an empty clipboard.
    */
    mockAnswer = false;
    expect(await writeClipboard("https://context.lc/s/abc")).toBe(false);
    expect(mockWritten).toEqual([]);
  });

  test("and a clipboard that throws is a refusal too, not a crash", async () => {
    // A throw reaches `copyController` and `MeetingNoteScreen` through an
    // unhandled rejection otherwise — the label sticks and the screen has no
    // idea. Reported, never faked.
    mockThrows = true;
    await expect(writeClipboard("anything")).resolves.toBe(false);
  });
});

describe("the native deferred copy", () => {
  test("produces once, then writes what it produced", async () => {
    let minted = 0;
    const result = await copyDeferred(async () => {
      minted += 1;
      return "https://context.lc/s/abc";
    });

    expect(result).toEqual({ ok: true, text: "https://context.lc/s/abc" });
    expect(minted).toBe(1);
    expect(mockWritten).toEqual(["https://context.lc/s/abc"]);
  });

  test("NOTHING TO COPY NEVER REACHES THE CLIPBOARD AT ALL", async () => {
    /*
      The same property the web half had to be fixed to keep, arrived at from
      the other side. There, the write is issued before the outcome is known —
      that is what preserves Safari's activation window — so declining means
      rejecting the part, and resolving an empty blob instead **emptied the
      clipboard** on a failed mint.

      Native has no activation window and therefore no such trap: it produces
      first and writes second, so a refusal simply never calls the clipboard.
      That is the better shape, and it is worth an assertion precisely because
      it is the shape somebody would "simplify" into the web one while making
      the two halves match.
    */
    const result = await copyDeferred(async () => null);

    expect(result).toEqual({ ok: false, text: null });
    expect(mockWritten).toEqual([]);
  });

  test("and a write the system refused comes back with the text anyway", async () => {
    // A caller that could not copy still has something worth showing: the URL
    // itself, so the dialog can put it on screen to be selected by hand.
    mockAnswer = false;
    expect(await copyDeferred(async () => "https://context.lc/s/abc")).toEqual({
      ok: false,
      text: "https://context.lc/s/abc",
    });
  });
});
