import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * The one test account whose OTP is a constant.
 *
 * The patch in `patches/@convex-dev__auth.patch` (the `signIn.js` hunk): when
 * `TEST_OTP_EMAIL` and `TEST_OTP_CODE` are both set on the deployment, a
 * sign-in for exactly that address mints the fixed code instead of a random
 * one. It exists so automated flows — Playwright, an agent driving the live
 * site — can sign in without reading a mailbox.
 *
 * What it deliberately does NOT change, and what this suite pins:
 *
 *  - **Scope.** Every other address still gets a random six-digit code, with
 *    both variables set. A bypass that leaked to a second address would be a
 *    skeleton key, not a test account.
 *  - **Default.** With the variables unset the fixed code verifies for
 *    nobody, the test account included. A deployment that never opted in
 *    carries no bypass.
 *  - **The verification path.** The fixed code is stored and checked exactly
 *    like a real one — bound to the address, rate-limited under it, expiring
 *    on the provider's clock. Only the minted digits differ.
 *
 * Like `authTokenReuse.test.ts` on the mobile side, this drives the patched
 * dist through the public surface (`api.auth.signIn`), so a dependency bump
 * that drops the patch fails here rather than in a live sign-in.
 */

const TEST_EMAIL = "agentseyi@agentmail.to";
const TEST_CODE = "000000";

const ENV_KEYS = [
  "TEST_OTP_EMAIL",
  "TEST_OTP_CODE",
  "RESEND_API_KEY",
  "SITE_URL",
  "CONVEX_SITE_URL",
  "JWT_PRIVATE_KEY",
] as const;
let previous: Map<string, string | undefined>;
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  // No RESEND_API_KEY → the provider logs the code instead of mailing it, so
  // nothing here needs a Resend stub.
  delete process.env.RESEND_API_KEY;
  // Redeeming a code mints a JWT, which needs a signing key and the URLs the
  // token names — same recipe as invitationEmail.test.ts's redemption test.
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.JWT_PRIVATE_KEY = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  process.env.SITE_URL = "https://context.invalid";
  process.env.CONVEX_SITE_URL = "https://context.invalid";
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network access attempted");
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    const was = previous.get(key);
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

function enableTestAccount() {
  process.env.TEST_OTP_EMAIL = TEST_EMAIL;
  process.env.TEST_OTP_CODE = TEST_CODE;
}

/** Request a code for `email`, then try to redeem `code` for it. */
async function requestThenVerify(t: TestConvex, email: string, code: string) {
  await t.action(api.auth.signIn, { provider: "email", params: { email } });
  return t.action(api.auth.signIn, {
    provider: "email",
    params: { email, code },
  });
}

describe("with the test account configured", () => {
  test("the named address signs in with the fixed code", async () => {
    enableTestAccount();
    const t = setupTest();
    const result = await requestThenVerify(t, TEST_EMAIL, TEST_CODE);
    expect(result.tokens).not.toBeNull();
    expect(typeof result.tokens!.token).toBe("string");
  });

  test("case and whitespace do not defeat the match", async () => {
    enableTestAccount();
    const t = setupTest();
    const result = await requestThenVerify(t, "AgentSeyi@AgentMail.to", TEST_CODE);
    expect(result.tokens).not.toBeNull();
  });

  test("every other address still gets a real code — the fixed one verifies for nobody else", async () => {
    enableTestAccount();
    const t = setupTest();
    await expect(
      requestThenVerify(t, "somebody-else@example.invalid", TEST_CODE),
    ).rejects.toThrow(/Could not verify code/);
  });
});

describe("without the variables set", () => {
  test("the test account is an ordinary account and the fixed code fails", async () => {
    delete process.env.TEST_OTP_EMAIL;
    delete process.env.TEST_OTP_CODE;
    const t = setupTest();
    await expect(requestThenVerify(t, TEST_EMAIL, TEST_CODE)).rejects.toThrow(
      /Could not verify code/,
    );
  });
});
