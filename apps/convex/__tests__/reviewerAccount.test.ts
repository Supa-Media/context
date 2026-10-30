import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { isProductionTestAccount, TEST_ACCOUNT_EMAIL, testAccountEmail } from "../functions/lib/testAccount";
import {
  appReviewPhoneCodeMatches,
  GOOGLE_REVIEW_EMAIL,
  googleReviewTestEmail,
  REVIEWER_EMAIL,
  reviewerTestEmail,
} from "../functions/lib/reviewerAccount";

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

describe("Google's verification reviewer's sign-in", () => {
  test("is off unless the deployment holds a code", () => {
    expect(googleReviewTestEmail({})).toEqual([]);
    for (const code of ["12345", "abcdef", "000000"]) {
      expect(googleReviewTestEmail({ GOOGLE_REVIEW_SIGNIN_CODE: code })).toEqual([]);
    }
  });

  test("never shares a code with another fixed sign-in, the public App Store one above all", () => {
    for (const other of ["REVIEWER_SIGNIN_CODE", "APP_REVIEW_SIGNIN_CODE", "TEST_ACCOUNT_SIGNIN_CODE"]) {
      expect(googleReviewTestEmail({ GOOGLE_REVIEW_SIGNIN_CODE: "731905", [other]: " 731905 " })).toEqual([]);
    }
  });

  test("registers a provider of its own for its own address", () => {
    const env = { GOOGLE_REVIEW_SIGNIN_CODE: "731905", REVIEWER_SIGNIN_CODE: "482913" };
    expect(googleReviewTestEmail(env)).toEqual([{ email: GOOGLE_REVIEW_EMAIL, code: "731905", id: "test-email-google-review" }]);
    expect(isProductionTestAccount({ email: GOOGLE_REVIEW_EMAIL, emailVerificationTime: 1 })).toBe(false);
  });
});

describe("no fixed sign-in code lives in this public repository", () => {
  test("the CUJ account's code comes from the deployment, or there is no provider", () => {
    expect(testAccountEmail({})).toEqual([]);
    for (const code of ["000000", "12345", "abcdef"]) {
      expect(testAccountEmail({ TEST_ACCOUNT_SIGNIN_CODE: code })).toEqual([]);
    }
    expect(testAccountEmail({ TEST_ACCOUNT_SIGNIN_CODE: " 582046 " })).toEqual([{ email: TEST_ACCOUNT_EMAIL, code: "582046" }]);
  });

  test("the App Store review phone defaults to the directory reviewer's code", () => {
    const env = { REVIEWER_SIGNIN_CODE: "482913" };
    expect(appReviewPhoneCodeMatches("482913", env)).toBe(true);
    expect(appReviewPhoneCodeMatches("000000", env)).toBe(false);
    expect(appReviewPhoneCodeMatches("482913", {})).toBe(false);
  });

  test("the submitted App Store code can stay separate from the directory code", () => {
    const env = { REVIEWER_SIGNIN_CODE: "482913", APP_REVIEW_SIGNIN_CODE: " 000000 " };
    expect(appReviewPhoneCodeMatches("000000", env)).toBe(true);
    expect(appReviewPhoneCodeMatches("482913", env)).toBe(false);
    expect(reviewerTestEmail(env)[0]?.code).toBe("482913");
  });

  test("an invalid App Store override disables the alias rather than using another code", () => {
    for (const code of ["12345", "1234567", "abcdef"]) {
      const env = { REVIEWER_SIGNIN_CODE: "482913", APP_REVIEW_SIGNIN_CODE: code };
      expect(appReviewPhoneCodeMatches(code, env)).toBe(false);
      expect(appReviewPhoneCodeMatches("482913", env)).toBe(false);
    }
    expect(appReviewPhoneCodeMatches("000000", { APP_REVIEW_SIGNIN_CODE: "000000" })).toBe(false);
  });

  test("auth.ts writes no six-digit code", () => {
    const source = readFileSync(new URL("../auth.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/code\s*(:|===)\s*"\d{6}"/);
  });
});
