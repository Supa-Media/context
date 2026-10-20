import { describe, expect, test } from "@jest/globals";
import { messagesHref, TEXT_ROUTE } from "../features/tex/launch/routes";
import { googleWarning, newGmail } from "../features/auth/gmailFirst/gmailFirst";
import { safeNextRoute } from "../features/auth/redirect";

/**
 * tex.lc signed in and Gmail first (Dev2, 2026-10-20): the small rules the
 * pages rest on.
 */
describe("Open Messages", () => {
  test("types hi for somebody who has never texted Tex, and nothing after", () => {
    expect(messagesHref("+15555550177", true)).toBe("sms:+15555550177?&body=hi");
    expect(messagesHref("+15555550177", false)).toBe("sms:+15555550177");
  });
});

describe("signing in on tex.lc comes back to /text", () => {
  test("/text is a next the sign-in page keeps", () => {
    expect(safeNextRoute(TEXT_ROUTE)).toBe("/text");
  });
});

describe("the page Google returns to", () => {
  test("names the Gmail that was not there before, and waits while the binding lands", () => {
    expect(newGmail(["a@gmail.com"], ["a@gmail.com"])).toBeNull();
    expect(newGmail(["a@gmail.com"], ["a@gmail.com", "b@work.example"])).toBe("b@work.example");
    expect(newGmail([], ["a@gmail.com"])).toBe("a@gmail.com");
  });

  test("Google's warning says tap on a phone and click on a computer", () => {
    expect(googleWarning(true)).toContain("tap Advanced, then Go to Context");
    expect(googleWarning(false)).toContain("click Advanced");
  });
});
