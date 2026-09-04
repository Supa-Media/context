import { describe, expect, test } from "@jest/globals";
import { unmatchedSegments } from "../features/app/unmatched";

/**
 * The screen a URL nobody anticipated lands on, and the one link it recovers.
 *
 * `+not-found.tsx` exists to replace Expo Router's built-in **Unmatched Route**
 * screen — a development aid that ships, and what a `context://note/…` link
 * from ChatGPT rendered on iOS on 2026-09-03. Declaring the route is the whole
 * of that fix (`getNavigationConfig` installs the built-in only when the app
 * has not), and `htmlShell.test.ts`-style structure checks would not catch its
 * absence, so the assertion that it exists is the file being there.
 *
 * What is worth testing is the part that can silently stop working: reading the
 * segments the router hands it. The param's **name** is an implementation
 * detail of a dependency — `not-found` in expo-router 6, `unmatched` in the
 * documentation and in earlier versions — and getting it wrong does not fail
 * loudly. The screen still renders; the only thing that quietly stops is
 * recovering a note link somebody was sent.
 */

describe("reading the path a not-found route was reached with", () => {
  test("expo-router 6 names it `not-found`", () => {
    // Derived, not guessed: `getReactNavigationConfig` turns the `+not-found`
    // segment into the pattern `*not-found`, and `replacePart` strips the `*`.
    expect(unmatchedSegments({ "not-found": ["note", "@supa", "a.md"] })).toEqual([
      "note",
      "@supa",
      "a.md",
    ]);
  });

  test("the older name still works", () => {
    expect(unmatchedSegments({ unmatched: ["note", "@supa", "a.md"] })).toEqual([
      "note",
      "@supa",
      "a.md",
    ]);
  });

  test("a renamed param is still found, because a catch-all is an array", () => {
    /*
      The fallback, and it is a fact about the route rather than a guess about
      the key: a `+not-found` route has exactly one dynamic parameter, it is a
      catch-all, and `getParamValue` gives a catch-all its value as an array.
      Query parameters are strings.
    */
    expect(unmatchedSegments({ "something-else": ["note", "@supa", "a.md"] })).toEqual([
      "note",
      "@supa",
      "a.md",
    ]);
  });

  test("a query parameter is not mistaken for the path", () => {
    expect(unmatchedSegments({ utm_source: "chat", ref: "x" })).toEqual([]);
  });

  test("a single-segment path arrives as a bare string", () => {
    expect(unmatchedSegments({ "not-found": "typo" })).toEqual(["typo"]);
  });

  test("no params at all is no path", () => {
    expect(unmatchedSegments({})).toEqual([]);
  });
});
