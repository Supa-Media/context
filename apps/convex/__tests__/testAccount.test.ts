import { describe, expect, test } from "vitest";
import { isProductionTestAccount, TEST_ACCOUNT_EMAIL } from "../functions/lib/testAccount";

describe("production test account boundary", () => {
  test("accepts only the verified configured address", () => {
    expect(isProductionTestAccount({ email: TEST_ACCOUNT_EMAIL, emailVerificationTime: 1 })).toBe(true);
    expect(isProductionTestAccount({ email: " AgentSeyi@AgentMail.To ", emailVerificationTime: 1 })).toBe(true);
    expect(isProductionTestAccount({ email: TEST_ACCOUNT_EMAIL })).toBe(false);
    expect(isProductionTestAccount({ email: "customer@example.com", emailVerificationTime: 1 })).toBe(false);
    expect(isProductionTestAccount(null)).toBe(false);
  });
});
