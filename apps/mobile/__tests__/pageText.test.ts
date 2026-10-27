/**
 * Which note is shown as its text rather than as its page (`pageText.ts`):
 * the ••• sheet's "Edit as text" sets it, the note screen and the phone's
 * bottom bar read it. Keyed by path, so another page opens as a page again.
 *
 * SABOTAGE: make `pageAsText` ignore the path (`textPath !== null`). "another
 * page still opens as its page" fails.
 */

import { describe, expect, test } from "@jest/globals";
import { pageAsText, setPageAsText } from "../features/console/files/pageView/pageText";

describe("a page shown as text", () => {
  test("Edit as text holds for that page only, and View as page puts it back", () => {
    expect(pageAsText("a/plan.page.md")).toBe(false);
    setPageAsText("a/plan.page.md", true);
    expect(pageAsText("a/plan.page.md")).toBe(true);
    // another page still opens as its page
    expect(pageAsText("a/other.page.md")).toBe(false);
    // turning another off leaves this one alone
    setPageAsText("a/other.page.md", false);
    expect(pageAsText("a/plan.page.md")).toBe(true);
    setPageAsText("a/plan.page.md", false);
    expect(pageAsText("a/plan.page.md")).toBe(false);
    expect(pageAsText(null)).toBe(false);
  });
});
