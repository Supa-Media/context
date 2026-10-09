import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_LANDING_PAGE,
  LANDING_PAGES,
  landingPageFromPath,
  landingPageOf,
} from "@context/shared";

/**
 * The five landing pages (`/a` to `/e`) and what they are named by. The
 * waitlist records which one a person saw (`landing`), so both the client that
 * reads the URL and the server that validates the value rely on this one rule.
 * The server half is in `apps/convex/__tests__/waitlist.test.ts`.
 */

describe("the landing pages", () => {
  test("are a, b, c, d and e, with a as the default", () => {
    expect([...LANDING_PAGES]).toEqual(["a", "b", "c", "d", "e"]);
    expect(DEFAULT_LANDING_PAGE).toBe("a");
  });

  test("a stored value is kept only when it is exactly one of them", () => {
    for (const page of LANDING_PAGES) expect(landingPageOf(page)).toBe(page);
    for (const raw of ["z", "A", "<script>", "", " a", "a ", 1, null, undefined, ["a"]]) {
      expect(landingPageOf(raw)).toBeUndefined();
    }
  });

  test("the home page is the default, and /a to /e are their own pages", () => {
    expect(landingPageFromPath("/")).toBe("a");
    for (const page of LANDING_PAGES) {
      expect(landingPageFromPath(`/${page}`)).toBe(page);
      expect(landingPageFromPath(`/${page}/`)).toBe(page);
    }
  });

  test("any other path is no landing page", () => {
    for (const path of ["", "/f", "/A", "/ab", "/a/b", "//a", "/a//", "/login", "/a?x=1", "a", "/a/c"]) {
      expect(landingPageFromPath(path)).toBeNull();
    }
  });
});
