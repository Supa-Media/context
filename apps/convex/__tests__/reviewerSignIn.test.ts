import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { setupTest, type TestConvex } from "./fixtures.helpers";
import { REVIEWER_EMAIL, REVIEWER_PROVIDER_ID } from "../functions/lib/reviewerAccount";

/**
 * The directory reviewer's sign-in, driven end to end.
 *
 * `reviewerAccount.test.ts` pins which codes build a provider. This drives the
 * provider that gets built through the public surface (`api.auth.signIn`), for
 * the two properties the account rests on: only this address can spend the
 * code, and — since the code is the same digits every time, stored under a
 * hash the verification table indexes globally — a stranger starting a sign-in
 * the provider refuses cannot leave a row under the key this address has to
 * read. See the fixed-code hunk in `patches/@convex-dev__auth.patch`.
 *
 * The code here is fake, six digits, and not the CUJ account's public one.
 */
const REVIEWER_CODE = "482913";
const ENV_KEYS = [
  "REVIEWER_SIGNIN_CODE",
  "RESEND_API_KEY",
  "SITE_URL",
  "CONVEX_SITE_URL",
  "JWT_PRIVATE_KEY",
] as const;
let previous: Map<string, string | undefined>;
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  // No RESEND_API_KEY: nothing here may reach a mail provider.
  delete process.env.RESEND_API_KEY;
  process.env.REVIEWER_SIGNIN_CODE = REVIEWER_CODE;
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

async function requestThenVerify(t: TestConvex, email: string, code: string) {
  await t.action(api.auth.signIn, {
    provider: REVIEWER_PROVIDER_ID,
    params: { email },
  });
  return t.action(api.auth.signIn, {
    provider: REVIEWER_PROVIDER_ID,
    params: { email, code },
  });
}

/** A start the provider refuses. The row it writes first is the point. */
async function refusedStart(t: TestConvex, email: string) {
  await expect(
    t.action(api.auth.signIn, {
      provider: REVIEWER_PROVIDER_ID,
      params: { email },
    }),
  ).rejects.toThrow(/not available/);
}

describe("the directory reviewer's provider, end to end", () => {
  test("the reviewer address signs in with the deployment's code", async () => {
    const result = await requestThenVerify(setupTest(), REVIEWER_EMAIL, REVIEWER_CODE);
    expect(result.tokens).not.toBeNull();
  });

  test("no other address can spend that code", async () => {
    await expect(
      requestThenVerify(setupTest(), "somebody-else@example.invalid", REVIEWER_CODE),
    ).rejects.toThrow(/not available/);
  });

  test("the CUJ account's public code does not open it", async () => {
    await expect(
      requestThenVerify(setupTest(), REVIEWER_EMAIL, "000000"),
    ).rejects.toThrow(/Could not verify code/);
  });

  test("strangers cannot spend the key the reviewer's code is filed under", async () => {
    const t = setupTest();
    await refusedStart(t, "stranger-one@example.invalid");
    await refusedStart(t, "stranger-two@example.invalid");
    const result = await requestThenVerify(t, REVIEWER_EMAIL, REVIEWER_CODE);
    expect(result.tokens).not.toBeNull();
  });
});
