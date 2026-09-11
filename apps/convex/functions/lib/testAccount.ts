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
