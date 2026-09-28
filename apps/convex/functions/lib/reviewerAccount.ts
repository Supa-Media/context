/**
 * The sign-in a Claude or ChatGPT directory reviewer uses.
 *
 * Both directories test a connector by signing in as an account we hand
 * them, and neither can read our email or pass a second step. So this
 * address signs in with a fixed code, through a provider of its own that
 * refuses every other address.
 *
 * The address is public, because the sign-in screen has to route it to that
 * provider. The code is not: it comes from `REVIEWER_SIGNIN_CODE` on the
 * deployment, and with no valid code no provider is registered at all, so
 * the address signs in like any customer's (by an emailed code). A malformed
 * value is skipped rather than thrown, because a throw here would take every
 * customer's sign-in down with it.
 *
 * The account holds no privileges: `isProductionTestAccount` names only the
 * CUJ address.
 */

export const REVIEWER_EMAIL = "connector-review@supa.media";
export const REVIEWER_PROVIDER_ID = "test-email-reviewer";

type Environment = Record<string, string | undefined>;

export function reviewerTestEmail(
  env: Environment = process.env,
): Array<{ email: string; code: string; id: string }> {
  const code = env.REVIEWER_SIGNIN_CODE?.trim() ?? "";
  if (code === "") return [];
  if (!/^\d{6}$/.test(code) || code === "000000") {
    console.error("REVIEWER_SIGNIN_CODE is not a six-digit code other than 000000; the reviewer sign-in is off.");
    return [];
  }
  return [{ email: REVIEWER_EMAIL, code, id: REVIEWER_PROVIDER_ID }];
}
