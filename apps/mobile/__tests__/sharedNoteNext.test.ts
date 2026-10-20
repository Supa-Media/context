import { describe, expect, test } from "@jest/globals";
import { isSharedNoteNext, shareTokenInNext } from "../features/auth/sharedNoteNext";

/**
 * Is the `?next=` a sign-in is carrying a link to a note? The login screen
 * uses the answer to say "someone shared a note with you" before anybody has
 * signed in, so it must say yes only for the note URL itself and nothing else.
 */
describe("recognising a shared-note link", () => {
  test("a console note link is a shared note", () => {
    expect(isSharedNoteNext("/console/@seyi?note=3-resources%2Fsetlist.md")).toBe(true);
    expect(isSharedNoteNext("/console/@public-worship?note=1-projects%2Fsunday.md")).toBe(true);
  });

  test("the console without a note is not", () => {
    expect(isSharedNoteNext("/console")).toBe(false);
    expect(isSharedNoteNext("/console/@seyi")).toBe(false);
    expect(isSharedNoteNext("/console/@seyi/settings")).toBe(false);
  });

  test("an empty note is not a note", () => {
    expect(isSharedNoteNext("/console/@seyi?note=")).toBe(false);
    expect(isSharedNoteNext("/console/@seyi?note=%20")).toBe(false);
  });

  test("other routes are not, even with a note parameter", () => {
    expect(isSharedNoteNext("/authorize?request_id=abc")).toBe(false);
    expect(isSharedNoteNext("/welcome")).toBe(false);
    expect(isSharedNoteNext("/invite/abc?note=x.md")).toBe(false);
    expect(isSharedNoteNext("/console-x/@seyi?note=x.md")).toBe(false);
  });

  test("a malformed next is not", () => {
    expect(isSharedNoteNext(undefined)).toBe(false);
    expect(isSharedNoteNext(null)).toBe(false);
    expect(isSharedNoteNext("")).toBe(false);
    expect(isSharedNoteNext("console/@seyi?note=x.md")).toBe(false);
    expect(isSharedNoteNext("/console/@?note=x.md")).toBe(false);
    expect(isSharedNoteNext("/console/@seyi?note=%E0%A4%A")).toBe(false);
  });

  test("an absolute or protocol-relative URL is not, whatever it names", () => {
    expect(isSharedNoteNext("https://evil.example/console/@seyi?note=x.md")).toBe(false);
    expect(isSharedNoteNext("//evil.example/console/@seyi?note=x.md")).toBe(false);
    expect(isSharedNoteNext("/\\evil.example/console/@seyi?note=x.md")).toBe(false);
    expect(isSharedNoteNext("/console\\@seyi?note=x.md")).toBe(false);
  });
});

describe("the share token a sign-in is carrying back to", () => {
  const TOKEN = "d".repeat(64);
  test("reads it from /s/<token> and /s/<slug>-<token>, with or without a path", () => {
    expect(shareTokenInNext(`/s/${TOKEN}`)).toBe(TOKEN);
    expect(shareTokenInNext(`/s/tobi-prep-${TOKEN}?path=1-projects%2Fa.md`)).toBe(TOKEN);
  });

  test("anything else is no token", () => {
    expect(shareTokenInNext(null)).toBeNull();
    expect(shareTokenInNext("/console")).toBeNull();
    expect(shareTokenInNext(`//evil.example/s/${TOKEN}`)).toBeNull();
    expect(shareTokenInNext(`https://evil.example/s/${TOKEN}`)).toBeNull();
    expect(shareTokenInNext("/s/not-a-token")).toBeNull();
    expect(shareTokenInNext(`/s/${TOKEN}/more`)).toBeNull();
  });
});
