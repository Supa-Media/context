import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { api, internal } from "../_generated/api";
import { setupTest, type TestConvex } from "./fixtures.helpers";
import { TEST_ACCOUNT_EMAIL } from "../functions/lib/testAccount";
import { DIRECTORY_REVIEW_EMAIL, GOOGLE_REVIEW_EMAIL, REVIEWER_EMAIL } from "../functions/lib/reviewerAccount";
import { MAX_ISSUED_CODE_MISSES } from "../functions/lib/issuedSignInCodes";
import { hashOneTimeCode } from "../functions/lib/oneTimeCodes";

/**
 * Sign-in for the accounts that cannot read their own mail: the CUJ account,
 * the App Store, directory and Google reviewers, and staging's personas.
 *
 * They used to take fixed codes that never expired, worked any number of
 * times and had no per-code attempt limit, which failed CASA 1.2.1, 1.3.1,
 * 1.3.2 and 1.3.4 (2026-11-11). Now staff issue one code at a time
 * (`functions/signInCodes.ts`), and this suite holds every issued code to the
 * controls a customer's code has: random, single-use, expiring, ten wrong
 * tries an hour under the address, plus ten in all against the code. It drives
 * the patched `@convex-dev/auth` through the public `auth:signIn`, so a
 * dependency bump that drops the patch fails here rather than in production.
 */

const ACCOUNTS = [
  { email: TEST_ACCOUNT_EMAIL, provider: "test-email" },
  { email: REVIEWER_EMAIL, provider: "test-email-reviewer" },
  { email: DIRECTORY_REVIEW_EMAIL, provider: "test-email-directory-review" },
  { email: GOOGLE_REVIEW_EMAIL, provider: "test-email-google-review" },
] as const;
const REVIEWER = ACCOUNTS[1];

const STAGING = {
  APP_ENV: "staging",
  APP_ORIGIN: "https://staging.context.lc",
  STAGING_CONVEX_DEPLOYMENT: "example-deployment",
  CONVEX_CLOUD_URL: "https://example-deployment.convex.cloud",
};

let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("OPEN_SIGNUP", "true");
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("JWT_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  vi.stubEnv("AUTH_CODE_HASH_KEY", "");
  vi.stubEnv("SITE_URL", "https://context.invalid");
  vi.stubEnv("CONVEX_SITE_URL", "https://context.invalid");
  // The retired fixed codes, set to prove nothing reads them any more.
  for (const name of ["REVIEWER_SIGNIN_CODE", "DIRECTORY_REVIEW_SIGNIN_CODE", "GOOGLE_REVIEW_SIGNIN_CODE", "APP_REVIEW_SIGNIN_CODE", "TEST_ACCOUNT_SIGNIN_CODE"]) {
    vi.stubEnv(name, "482913");
  }
  vi.stubEnv("TEST_OTP_EMAIL", TEST_ACCOUNT_EMAIL);
  vi.stubEnv("TEST_OTP_CODE", "000000");
  vi.stubEnv("DEV_OTP_BYPASS", "true");
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network access attempted");
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function issue(t: TestConvex, email: string) {
  return await t.mutation(internal.functions.signInCodes.issue, { email });
}

async function signIn(t: TestConvex, provider: string, email: string, code: string) {
  return await t.action(api.auth.signIn, { provider, params: { email, code } });
}

describe("an issued code", () => {
  for (const account of ACCOUNTS) {
    test(`signs ${account.email} in once, and only once`, async () => {
      const t = setupTest();
      const { code } = await issue(t, account.email);
      expect(code).toMatch(/^\d{6}$/);
      expect((await signIn(t, account.provider, account.email, code)).tokens).toBeTruthy();
      await expect(signIn(t, account.provider, account.email, code)).rejects.toThrow(/Could not verify code/);
    });
  }

  test("is random: two issues give two codes, and the second replaces the first", async () => {
    const t = setupTest();
    const first = await issue(t, REVIEWER.email);
    let second = await issue(t, REVIEWER.email);
    // One in a million they match; issue again rather than flake.
    if (second.code === first.code) second = await issue(t, REVIEWER.email);
    expect(second.code).not.toBe(first.code);
    await expect(signIn(t, REVIEWER.provider, REVIEWER.email, first.code)).rejects.toThrow(/Could not verify code/);
    expect((await signIn(t, REVIEWER.provider, REVIEWER.email, second.code)).tokens).toBeTruthy();
  });

  for (const account of ACCOUNTS) {
    test(`expires at ten minutes, including the boundary, for ${account.email}`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const t = setupTest();
      const { code, expiresAt } = await issue(t, account.email);
      expect(expiresAt - Date.now()).toBe(10 * 60 * 1000);
      vi.setSystemTime(expiresAt);
      await expect(signIn(t, account.provider, account.email, code)).rejects.toThrow(/Could not verify code/);
    });
  }

  test("still works just before its ten-minute expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const { code, expiresAt } = await issue(t, REVIEWER.email);
    vi.setSystemTime(expiresAt - 1);
    expect((await signIn(t, REVIEWER.provider, REVIEWER.email, code)).tokens).toBeTruthy();
  });

  test("refuses the retired days override, or any other address", async () => {
    const t = setupTest();
    await expect(t.mutation(internal.functions.signInCodes.issue, { email: REVIEWER.email, days: 14 } as never)).rejects.toThrow();
    await expect(issue(t, "customer@example.invalid")).rejects.toThrow(/only for/);
  });

  test("an already-issued multi-day code is refused after ten minutes from its original issue", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const { code } = await issue(t, REVIEWER.email);
    const oldIssue = Date.now() - 10 * 60 * 1000;
    await t.run(async (ctx) => {
      const [issued] = await ctx.db.query("issuedSignInCodes").collect();
      const [verification] = await ctx.db.query("authVerificationCodes").collect();
      await ctx.db.patch(issued!._id, { issuedAt: oldIssue, expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000 });
      await ctx.db.patch(verification!._id, { expirationTime: Date.now() + 14 * 24 * 60 * 60 * 1000 });
    });
    await expect(signIn(t, REVIEWER.provider, REVIEWER.email, code)).rejects.toThrow(/Could not verify code/);
    expect(await t.run((ctx) => ctx.db.query("authVerificationCodes").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("issuedSignInCodes").collect())).toEqual([]);
  });

  test("an issued-provider code without its lifecycle record cannot sign in", async () => {
    const t = setupTest();
    const { code } = await issue(t, REVIEWER.email);
    await t.run(async (ctx) => {
      const [issued] = await ctx.db.query("issuedSignInCodes").collect();
      await ctx.db.delete(issued!._id);
    });
    await expect(signIn(t, REVIEWER.provider, REVIEWER.email, code)).rejects.toThrow(/Could not verify code/);
  });

  test("guesses through another provider cannot consume an issued code's lifecycle", async () => {
    const t = setupTest();
    const { code } = await issue(t, REVIEWER.email);
    for (let miss = 0; miss < 3; miss++) {
      await expect(signIn(t, "email", REVIEWER.email, "000000")).rejects.toThrow();
    }
    const [row] = await t.run((ctx) => ctx.db.query("issuedSignInCodes").collect());
    expect(row!.misses).toBe(0);
    expect((await signIn(t, REVIEWER.provider, REVIEWER.email, code)).tokens).toBeTruthy();
  });

  test("opens only its own account", async () => {
    const t = setupTest();
    const { code } = await issue(t, REVIEWER.email);
    for (const other of ACCOUNTS.slice(2)) {
      await expect(signIn(t, other.provider, other.email, code)).rejects.toThrow();
    }
    await expect(signIn(t, REVIEWER.provider, "stranger@example.invalid", code)).rejects.toThrow();
    await expect(signIn(t, "email", REVIEWER.email, code)).rejects.toThrow();
    expect((await signIn(t, REVIEWER.provider, REVIEWER.email, code)).tokens).toBeTruthy();
  });

  test("is not replaced by anybody starting a sign-in for the public address", async () => {
    const t = setupTest();
    const { code } = await issue(t, REVIEWER.email);
    // The address is public; a start through its provider mints nothing.
    await t.action(api.auth.signIn, { provider: REVIEWER.provider, params: { email: REVIEWER.email } });
    await t.action(api.auth.signIn, { provider: REVIEWER.provider, params: { email: "stranger@example.invalid" } });
    expect((await signIn(t, REVIEWER.provider, REVIEWER.email, code)).tokens).toBeTruthy();
  });

  test("a start through these providers mints no code, fixed or otherwise", async () => {
    const t = setupTest();
    for (const account of ACCOUNTS) {
      await t.action(api.auth.signIn, { provider: account.provider, params: { email: account.email } });
    }
    expect(await t.run((ctx) => ctx.db.query("authVerificationCodes").collect())).toEqual([]);
    for (const account of ACCOUNTS) {
      for (const code of ["482913", "000000"]) {
        await expect(signIn(t, account.provider, account.email, code)).rejects.toThrow(/Could not verify code/);
      }
    }
  });

  test(`dies after ${MAX_ISSUED_CODE_MISSES} wrong codes before its expiry`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const { code } = await issue(t, REVIEWER.email);
    const wrong = code === "111111" ? "222222" : "111111";
    for (let miss = 0; miss < MAX_ISSUED_CODE_MISSES; miss++) {
      vi.setSystemTime(Date.now() + 1000);
      await expect(signIn(t, REVIEWER.provider, REVIEWER.email, wrong)).rejects.toThrow(/Could not verify code/);
    }
    await expect(signIn(t, REVIEWER.provider, REVIEWER.email, code)).rejects.toThrow(/Could not verify code/);
    expect(await t.run((ctx) => ctx.db.query("authVerificationCodes").collect())).toEqual([]);
  });

  test("keeps the ten-an-hour limit every address has", async () => {
    const t = setupTest();
    const { code } = await issue(t, REVIEWER.email);
    const wrong = code === "111111" ? "222222" : "111111";
    for (let miss = 0; miss < 9; miss++) {
      await expect(signIn(t, REVIEWER.provider, REVIEWER.email, wrong)).rejects.toThrow();
    }
    // Nine misses: the code still lives, and the right one still works.
    expect((await signIn(t, REVIEWER.provider, REVIEWER.email, code)).tokens).toBeTruthy();
    const next = await issue(t, REVIEWER.email);
    for (let miss = 0; miss < 10; miss++) {
      await expect(signIn(t, REVIEWER.provider, REVIEWER.email, wrong)).rejects.toThrow();
    }
    // The hour's ten are spent: even the right code waits.
    await expect(signIn(t, REVIEWER.provider, REVIEWER.email, next.code)).rejects.toThrow();
  });

  test("is stored as a keyed hash, never the digits or their plain SHA-256", async () => {
    const t = setupTest();
    const { code } = await issue(t, REVIEWER.email);
    const typed = `${REVIEWER.provider}:${REVIEWER.email}:${code}`;
    const [row] = await t.run((ctx) => ctx.db.query("authVerificationCodes").collect());
    expect(row!.code).not.toContain(code);
    expect(row!.code).not.toBe(createHash("sha256").update(typed).digest("hex"));
    expect(row!.code).toBe(await hashOneTimeCode("convex-auth", typed));
  });

  test("a stolen stored MAC cannot be replayed as the sign-in code", async () => {
    const t = setupTest();
    const { code } = await issue(t, REVIEWER.email);
    const [row] = await t.run((ctx) => ctx.db.query("authVerificationCodes").collect());
    await expect(signIn(t, REVIEWER.provider, REVIEWER.email, row!.code)).rejects.toThrow(/Could not verify code/);
    expect((await signIn(t, REVIEWER.provider, REVIEWER.email, code)).tokens).toBeTruthy();
  });
});

describe("staging's personas", () => {
  test("are issued a fresh ten-minute code on staging, never 000000", async () => {
    for (const [key, value] of Object.entries(STAGING)) vi.stubEnv(key, value);
    const t = setupTest();
    const { code, expiresAt } = await issue(t, "alpha@supa.media");
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    await expect(signIn(t, "email", "beta@supa.media", "000000")).rejects.toThrow();
    expect((await signIn(t, "email", "alpha@supa.media", code)).tokens).toBeTruthy();
    await expect(signIn(t, "email", "alpha@supa.media", code)).rejects.toThrow(/Could not verify code/);
  });

  test("can all hold a code at once, each its own", async () => {
    for (const [key, value] of Object.entries(STAGING)) vi.stubEnv(key, value);
    const t = setupTest();
    const personas = ["alpha", "beta", "gamma", "delta", "epsilon"].map((name) => `${name}@supa.media`);
    const codes = [];
    for (const email of personas) codes.push((await issue(t, email)).code);
    for (const [index, email] of personas.entries()) {
      expect((await signIn(t, "email", email, codes[index]!)).tokens).toBeTruthy();
    }
  });

  test("are refused a code anywhere but staging", async () => {
    const t = setupTest();
    await expect(issue(t, "alpha@supa.media")).rejects.toThrow(/only on staging/);
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("APP_ORIGIN", "https://staging.context.lc");
    await expect(issue(t, "alpha@supa.media")).rejects.toThrow(/only on staging/);
  });
});

describe("mailing a review code to the team", () => {
  test("sends the code to the team inbox and hands the caller only its expiry", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("SIGNUP_ALERTS_EMAIL", "team@example.invalid");
    const sent: Array<{ to: string; text: string }> = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }) as never;
    const t = setupTest();
    const answer = await t.action(internal.functions.signInCodes.mailToTeam, { email: REVIEWER.email });
    expect(Object.keys(answer).sort()).toEqual(["expiresAt", "mailed"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("team@example.invalid");
    const code = /: (\d{6})\n/.exec(sent[0]!.text)?.[1];
    expect(code).toBeDefined();
    expect((await signIn(t, REVIEWER.provider, REVIEWER.email, code!)).tokens).toBeTruthy();
  });

  test("refuses when there is no team inbox to send it to", async () => {
    vi.stubEnv("SIGNUP_ALERTS_EMAIL", "");
    const t = setupTest();
    await expect(t.action(internal.functions.signInCodes.mailToTeam, { email: REVIEWER.email })).rejects.toThrow(/team inbox/);
    expect(await t.run((ctx) => ctx.db.query("authVerificationCodes").collect())).toEqual([]);
  });
});

describe("codes stored before they were keyed", () => {
  async function storeLegacy(t: TestConvex, provider: string, email: string, code: string) {
    await t.mutation(internal.auth.store, {
      args: { type: "createVerificationCode", provider, email, code, expirationTime: Date.now() + 60_000, allowExtraProviders: false },
    });
    // Rewrite the row as it was kept before 2026-11-11: plain SHA-256.
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("authVerificationCodes").collect();
      await ctx.db.patch(row!._id, { code: createHash("sha256").update(code).digest("hex") });
    });
  }

  test("an invitation link's 190-bit token still opens by its old hash until it expires", async () => {
    const t = setupTest();
    const token = "a".repeat(64);
    await storeLegacy(t, "magic-link", "invitee@example.invalid", token);
    expect((await t.action(api.auth.signIn, { provider: "magic-link", params: { code: token } })).tokens).toBeTruthy();
  });

  test("a six-digit code is never read by its old plain hash", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const t = setupTest();
    await storeLegacy(t, "email", "person@example.invalid", "123456");
    await expect(signIn(t, "email", "person@example.invalid", "123456")).rejects.toThrow(/Could not verify code/);
  });
});
