import { describe, expect, test } from "@jest/globals";
import { attemptedHrefFrom } from "../features/auth/redirect";

/**
 * Which URL `/login?next=…` is built from.
 *
 * The rule is one line and it was wrong twice, so it is a pure function with a
 * table rather than a condition inside a layout. `attemptedHref.ts` carries the
 * measured evidence; this pins the behaviour.
 */
describe("the URL a sign-in redirect carries", () => {
  const ROUTER = "/console/@seyi?slug=%40seyi";

  test("the document's own URL wins over the router's reconstruction", () => {
    expect(
      attemptedHrefFrom(
        { pathname: "/console/@seyi", search: "?note=3-resources%2Fa.md" },
        ROUTER,
      ),
    ).toBe("/console/@seyi?note=3-resources%2Fa.md");
  });

  test("a path with no query is the path", () => {
    expect(attemptedHrefFrom({ pathname: "/console/@seyi", search: "" }, ROUTER)).toBe(
      "/console/@seyi",
    );
  });

  test("no browser URL falls back to the router — that is React Native", () => {
    // A `window` with no `location` is not an edge case, it is every native
    // build. Each of these must reach the fallback rather than being dressed
    // up as a URL: `safeNextRoute` would narrow the result to the console and
    // the note would be lost quietly instead of loudly.
    for (const browser of [
      null,
      undefined,
      {},
      { pathname: undefined },
      { pathname: null },
      { pathname: "" },
      // Not rooted, so not a path this app can return to.
      { pathname: "console/@seyi", search: "?note=a.md" },
    ]) {
      expect(attemptedHrefFrom(browser, ROUTER)).toBe(ROUTER);
    }
  });

  test("a missing search is an empty one, never the string 'undefined'", () => {
    // Concatenating an absent `search` is how a redirect target picks up a
    // literal `undefined` and stops resolving to anything.
    expect(attemptedHrefFrom({ pathname: "/console" }, ROUTER)).toBe("/console");
    expect(attemptedHrefFrom({ pathname: "/console", search: null }, ROUTER)).toBe("/console");
  });
});
