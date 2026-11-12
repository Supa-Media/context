/** The production-only CUJ account. It must never hold customer data. */
export const TEST_ACCOUNT_EMAIL = "agentseyi@agentmail.to";

/** Exact, verified identity check used by every test-only privilege. */
export function isProductionTestAccount(user: {
  email?: string;
  emailVerificationTime?: number;
} | null): boolean {
  return (
    user?.emailVerificationTime !== undefined &&
    user.email?.trim().toLowerCase() === TEST_ACCOUNT_EMAIL
  );
}

/**
 * The CUJ account's provider. Always registered, and it opens only with a code
 * staff issue for it (`functions/signInCodes.ts`): random, single-use,
 * expiring, attempt-limited. Until 2026-11-11 it took a fixed code from
 * `TEST_ACCOUNT_SIGNIN_CODE` (and before that `TEST_OTP_EMAIL` /
 * `TEST_OTP_CODE` through the auth patch); nothing reads those now, because a
 * code that works every time fails CASA 1.2.1 / 1.3.x.
 */
export function testAccountEmail(): Array<{ email: string; id: string }> {
  return [{ email: TEST_ACCOUNT_EMAIL, id: "test-email" }];
}
