import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * The ordinary customer email code, end to end, as a security assessment asks
 * about it: how long it lives, that it works once, how many guesses it allows,
 * that it is random, and that only its hash is stored.
 *
 * The other sign-in suites prove these properties for the codes Context mints
 * itself (`phoneCodes.test.ts`, `textSignIn.test.ts`) and for the fixed-code
 * providers (`testAccountOtp.test.ts`). The everyday email code is minted by
 * `@supa-media/convex/auth` and checked by `@convex-dev/auth`
 * (`verifyCodeAndSignIn.js`, `rateLimit.js`), so this drives that path through
 * the public `api.auth.signIn`, reading each code off a stubbed Resend call
 * the way a person reads it off their mail.
 */

const EMAIL = "evidence@context.invalid";
const ENV_KEYS = ["RESEND_API_KEY", "SITE_URL", "CONVEX_SITE_URL", "JWT_PRIVATE_KEY", "OPEN_SIGNUP"] as const;
let previous: Map<string, string | undefined>;
let realFetch: typeof globalThis.fetch;
let mailed: string[];

beforeEach(async () => {
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  // A key, so the provider mails rather than logs; the fetch below is Resend.
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
  // Admission is `waitlist.test.ts`'s subject; here sign-up is open.
  process.env.OPEN_SIGNUP = "true";
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.JWT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.SITE_URL = "https://context.invalid";
  process.env.CONVEX_SITE_URL = "https://context.invalid";
  mailed = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "https://api.resend.com/emails") throw new Error(`network access attempted: ${String(input)}`);
    const subject = JSON.parse(String(init?.body)).subject as string;
    mailed.push(subject.slice(0, subject.indexOf(" ")));
    return new Response(JSON.stringify({ id: "email_test" }), { status: 200 });
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

async function requestCode(t: TestConvex, email = EMAIL): Promise<string> {
  await t.action(api.auth.signIn, { provider: "email", params: { email } });
  return mailed[mailed.length - 1]!;
}

function verify(t: TestConvex, code: string, email = EMAIL) {
  return t.action(api.auth.signIn, { provider: "email", params: { email, code } });
}

describe("the email sign-in code", () => {
  test("is six digits, and only its SHA-256 hash is stored", async () => {
    const t = setupTest();
    const code = await requestCode(t);
    expect(code).toMatch(/^\d{6}$/);
    const rows = await t.run((ctx) => ctx.db.query("authVerificationCodes").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  test("expires ten minutes after it is sent", async () => {
    const t = setupTest();
    const before = Date.now();
    await requestCode(t);
    const [row] = await t.run((ctx) => ctx.db.query("authVerificationCodes").collect());
    expect(row!.expirationTime).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(row!.expirationTime).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
  });

  test("an expired code is refused, and removed", async () => {
    const t = setupTest();
    const code = await requestCode(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("authVerificationCodes").collect()) await ctx.db.patch(row._id, { expirationTime: Date.now() - 1 });
    });
    await expect(verify(t, code)).rejects.toThrow(/Could not verify code/);
    expect(await t.run((ctx) => ctx.db.query("authVerificationCodes").collect())).toHaveLength(0);
  });

  test("signs in once: the same code a second time is refused", async () => {
    const t = setupTest();
    const code = await requestCode(t);
    expect((await verify(t, code)).tokens).not.toBeNull();
    await expect(verify(t, code)).rejects.toThrow(/Could not verify code/);
  });

  test("a new code replaces the last one", async () => {
    const t = setupTest();
    const first = await requestCode(t);
    let second = await requestCode(t);
    while (second === first) second = await requestCode(t);
    await expect(verify(t, first)).rejects.toThrow(/Could not verify code/);
    expect((await verify(t, second)).tokens).not.toBeNull();
  });

  test("ten wrong guesses in an hour, then even the right code is refused", async () => {
    const t = setupTest();
    const code = await requestCode(t);
    const wrong = code === "123456" ? "654321" : "123456";
    for (let guess = 0; guess < 10; guess++) await expect(verify(t, wrong)).rejects.toThrow(/Could not verify code/);
    await expect(verify(t, code)).rejects.toThrow(/Could not verify code/);
    // The code itself was not spent by the refusal: the limit, not the code, said no.
    expect(await t.run((ctx) => ctx.db.query("authVerificationCodes").collect())).toHaveLength(1);
  });

  test("a new code does not reset the guess limit", async () => {
    // The limit is kept per address, not per code: asking for another code
    // after ten wrong guesses buys no more guesses.
    const t = setupTest();
    const first = await requestCode(t);
    const wrong = first === "123456" ? "654321" : "123456";
    for (let guess = 0; guess < 10; guess++) await expect(verify(t, wrong)).rejects.toThrow(/Could not verify code/);
    const fresh = await requestCode(t);
    await expect(verify(t, fresh)).rejects.toThrow(/Could not verify code/);
  });

  test("one address's code does not sign in another", async () => {
    const t = setupTest();
    const code = await requestCode(t, "first@context.invalid");
    await requestCode(t, "second@context.invalid");
    await expect(verify(t, code, "second@context.invalid")).rejects.toThrow(/Could not verify code/);
  });

  test("codes are drawn from the whole six-digit space, not a pattern", async () => {
    const t = setupTest();
    const codes: string[] = [];
    for (let i = 0; i < 200; i++) codes.push(await requestCode(t));
    // 200 draws from 900,000 values: a repeat has ~2% odds, more than three is a broken generator.
    expect(200 - new Set(codes).size).toBeLessThanOrEqual(3);
    const leading = new Set(codes.map((code) => code[0]));
    expect(leading.size).toBeGreaterThanOrEqual(8);
    const mean = codes.reduce((sum, code) => sum + Number(code), 0) / codes.length;
    // Uniform on [100000, 999999] has mean 549,999.5 and a standard error of ~18,400 at n=200.
    expect(Math.abs(mean - 549_999.5)).toBeLessThan(100_000);
  });
});
