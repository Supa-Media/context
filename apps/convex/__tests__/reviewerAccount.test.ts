import { describe, expect, test } from "vitest";

import { isProductionTestAccount } from "../functions/lib/testAccount";
import { REVIEWER_EMAIL, reviewerTestEmail } from "../functions/lib/reviewerAccount";

describe("the directory reviewer's sign-in", () => {
  test("is off unless the deployment holds a code", () => {
    expect(reviewerTestEmail({})).toEqual([]);
    expect(reviewerTestEmail({ REVIEWER_SIGNIN_CODE: "  " })).toEqual([]);
  });

  test("refuses a malformed code, and the public CUJ code, without throwing", () => {
    for (const code of ["12345", "1234567", "abcdef", "000000"]) {
      expect(reviewerTestEmail({ REVIEWER_SIGNIN_CODE: code })).toEqual([]);
    }
  });

  test("registers a provider of its own that the CUJ provider cannot share", () => {
    const [reviewer] = reviewerTestEmail({ REVIEWER_SIGNIN_CODE: "482913" });
    expect(reviewer).toEqual({ email: REVIEWER_EMAIL, code: "482913", id: "test-email-reviewer" });
    // The framework refuses a repeated id and proves each provider refuses
    // every other address; this pins that the reviewer never reuses the CUJ id.
    expect(reviewer!.id).not.toBe("test-email");
  });

  test("carries none of the CUJ account's privileges", () => {
    expect(isProductionTestAccount({ email: REVIEWER_EMAIL, emailVerificationTime: 1 })).toBe(false);
  });
});
