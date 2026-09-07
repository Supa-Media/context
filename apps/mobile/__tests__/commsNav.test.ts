import { describe, expect, test } from "@jest/globals";
import { anchorFromQuery, noteHref } from "../features/console/nav";

/**
 * The routing contract a channel-day's message list and a per-anchor search
 * result both call: `noteHref(slug, path, anchor)`. One shape, so the two
 * features that deep-link into a message can never drift into two different
 * addresses for the same target.
 */
describe("noteHref with an anchor", () => {
  test("no anchor is the plain note link, unchanged", () => {
    expect(noteHref("seyi", "1-projects/a.md")).toBe("/console/@seyi?note=1-projects%2Fa.md");
  });

  test("an anchor adds &anchor=, not a URL fragment", () => {
    expect(noteHref("seyi", "0-inbox/email/name-at-example-com/2026-09-07", "msg-0123456789abcdef")).toBe(
      "/console/@seyi?note=0-inbox%2Femail%2Fname-at-example-com%2F2026-09-07&anchor=msg-0123456789abcdef",
    );
  });

  test("an empty anchor is the same as none", () => {
    expect(noteHref("seyi", "1-projects/a.md", "")).toBe("/console/@seyi?note=1-projects%2Fa.md");
  });
});

describe("anchorFromQuery", () => {
  test("a plain string", () => {
    expect(anchorFromQuery("msg-0123456789abcdef")).toBe("msg-0123456789abcdef");
  });

  test("expo-router's array-of-one shape for a repeated param", () => {
    expect(anchorFromQuery(["msg-0123456789abcdef", "msg-fedcba9876543210"])).toBe("msg-0123456789abcdef");
  });

  test("absent, empty, and whitespace-only all read as no anchor", () => {
    expect(anchorFromQuery(undefined)).toBeNull();
    expect(anchorFromQuery("")).toBeNull();
    expect(anchorFromQuery("   ")).toBeNull();
  });
});
