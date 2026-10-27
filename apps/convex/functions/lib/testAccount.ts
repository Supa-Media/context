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

type Environment = Record<string, string | undefined>;

/**
 * The CUJ account's fixed-code sign-in, or none.
 *
 * The code comes from `TEST_ACCOUNT_SIGNIN_CODE` on the deployment and never
 * from this public repository: a code written here signs anybody in to a
 * production account, which is the first thing a security assessment's scan
 * reports (owner, 2026-10-25). With no valid code no provider is registered,
 * and the address signs in like any other, by a code mailed to its inbox.
 * A malformed value is skipped rather than thrown, because a throw here would
 * take every customer's sign-in down with it; `000000` is refused because it
 * was the public code.
 */
export function testAccountEmail(
  env: Environment = process.env,
): Array<{ email: string; code: string }> {
  const code = env.TEST_ACCOUNT_SIGNIN_CODE?.trim() ?? "";
  if (code === "") return [];
  if (!/^\d{6}$/.test(code) || code === "000000") {
    console.error("TEST_ACCOUNT_SIGNIN_CODE is not a six-digit code other than 000000; the CUJ sign-in is off.");
    return [];
  }
  return [{ email: TEST_ACCOUNT_EMAIL, code }];
}
