import { describe, expect, test } from "@jest/globals";
import { landingSentence, pageLabel } from "../features/admin/waitlist";

/**
 * The Waitlist tab's landing-page words (`features/admin/waitlist.ts`): the
 * one-line summary of who joined from which page, and the small label each
 * row carries. The rows and the summary are drawn in
 * `adminWaitlistRender.test.ts`.
 */

describe("the landing page summary", () => {
  test("lists each page with its joins, in the order the server sent them", () => {
    expect(
      landingSentence([
        { landing: "a", joined: 12, admitted: 2 },
        { landing: "b", joined: 4, admitted: 0 },
        { landing: "none", joined: 30, admitted: 1 },
      ]),
    ).toBe("Joined from: a 12 · b 4 · none 30");
  });

  test("says nothing when nobody has joined yet", () => {
    expect(landingSentence([])).toBeNull();
  });
});

describe("a row's landing label", () => {
  test("names the page a row came from, and nothing for a row without one", () => {
    expect(pageLabel("c")).toBe("page c");
    expect(pageLabel(undefined)).toBeNull();
  });
});
