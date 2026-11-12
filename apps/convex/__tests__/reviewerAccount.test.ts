import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { isProductionTestAccount, TEST_ACCOUNT_EMAIL, testAccountEmail } from "../functions/lib/testAccount";
import {
  DIRECTORY_REVIEW_EMAIL,
  GOOGLE_REVIEW_EMAIL,
  REVIEWER_EMAIL,
  directoryReviewTestEmail,
  googleReviewTestEmail,
  reviewerTestEmail,
} from "../functions/lib/reviewerAccount";

/**
 * The CUJ and reviewer accounts' providers carry no code at all (CASA 1.2.1,
 * 1.3.1, 1.3.2, 1.3.4; 2026-11-11). They are always registered, each for its
 * own address, and open only with a code staff issue
 * (`issuedSignInCodes.test.ts` proves the codes' rules).
 */
const RETIRED = [
  "REVIEWER_SIGNIN_CODE",
  "DIRECTORY_REVIEW_SIGNIN_CODE",
  "APP_REVIEW_SIGNIN_CODE",
  "GOOGLE_REVIEW_SIGNIN_CODE",
  "TEST_ACCOUNT_SIGNIN_CODE",
  "TEST_OTP_EMAIL",
  "TEST_OTP_CODE",
];

describe("the exception accounts' providers", () => {
  test("each names one address and a provider of its own, and no code", () => {
    const all = [...testAccountEmail(), ...reviewerTestEmail(), ...directoryReviewTestEmail(), ...googleReviewTestEmail()];
    expect(all).toEqual([
      { email: TEST_ACCOUNT_EMAIL, id: "test-email" },
      { email: REVIEWER_EMAIL, id: "test-email-reviewer" },
      { email: DIRECTORY_REVIEW_EMAIL, id: "test-email-directory-review" },
      { email: GOOGLE_REVIEW_EMAIL, id: "test-email-google-review" },
    ]);
    for (const entry of all) expect(entry).not.toHaveProperty("code");
    expect(new Set(all.map((entry) => entry.id)).size).toBe(all.length);
  });

  test("only the CUJ account carries test privileges", () => {
    for (const email of [REVIEWER_EMAIL, DIRECTORY_REVIEW_EMAIL, GOOGLE_REVIEW_EMAIL]) {
      expect(isProductionTestAccount({ email, emailVerificationTime: 1 })).toBe(false);
    }
  });
});

describe("no fixed sign-in code is read from anywhere", () => {
  test("the retired code variables are read by no function", () => {
    const files = [
      "../auth.ts",
      "../functions/lib/reviewerAccount.ts",
      "../functions/lib/testAccount.ts",
      "../functions/phoneSignIn.ts",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      for (const name of RETIRED) expect(source, `${file} reads ${name}`).not.toContain(name);
    }
  });

  test("the auth patch mints no fixed or environment-named code", () => {
    const patch = readFileSync(new URL("../../../patches/@convex-dev__auth.patch", import.meta.url), "utf8");
    const added = patch.split("\n").filter((line) => line.startsWith("+")).join("\n");
    expect(added).not.toContain("TEST_OTP_");
    expect(added).not.toContain("000000");
    expect(added).not.toContain("stagingPersona");
  });

  test("auth.ts writes no six-digit code", () => {
    const source = readFileSync(new URL("../auth.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/code\s*(:|===)\s*"\d{6}"/);
  });
});
