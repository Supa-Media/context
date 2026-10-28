import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { setupTest, type TestConvex } from "./fixtures.helpers";
import { EMAIL_CODE_SENDS_PER_ADDRESS, EMAIL_CODE_SEND_WINDOW_MS, TOO_MANY_CODES } from "../functions/lib/emailCodeSends";

/**
 * How many email sign-in codes one address may be sent (`lib/emailCodeSends.ts`),
 * driven through the public `api.auth.signIn` with Resend stubbed.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   `store` exported unwrapped from `auth.ts`                                 5
 *   the key not lower-cased                                                   1
 *   every provider counted, not only `email`                                  1
 */

const EMAIL = "sends@context.invalid";
const ENV_KEYS = ["RESEND_API_KEY", "SITE_URL", "CONVEX_SITE_URL", "JWT_PRIVATE_KEY", "OPEN_SIGNUP"] as const;
let previous: Map<string, string | undefined>;
let realFetch: typeof globalThis.fetch;
let mailed: Array<{ to: string; code: string }>;

beforeEach(async () => {
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
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
    const body = JSON.parse(String(init?.body)) as { to: string; subject: string };
    mailed.push({ to: body.to, code: body.subject.slice(0, body.subject.indexOf(" ")) });
    return new Response(JSON.stringify({ id: "email_test" }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    const was = previous.get(key);
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

function ask(t: TestConvex, email = EMAIL) {
  return t.action(api.auth.signIn, { provider: "email", params: { email } });
}

function verify(t: TestConvex, code: string, email = EMAIL) {
  return t.action(api.auth.signIn, { provider: "email", params: { email, code } });
}

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; retryAfterMs?: number; message?: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    return (error as ConvexError<{ code?: string; retryAfterMs?: number; message?: string }>).data;
  }
  throw new Error("expected the request to be refused");
}

async function spend(t: TestConvex, email = EMAIL) {
  for (let i = 0; i < EMAIL_CODE_SENDS_PER_ADDRESS; i++) await ask(t, email);
}

describe("email code sends per address", () => {
  test("a person can ask again several times", async () => {
    const t = setupTest();
    await spend(t);
    expect(mailed).toHaveLength(EMAIL_CODE_SENDS_PER_ADDRESS);
  });

  test("one more is refused with when to try again, and nothing is mailed", async () => {
    const t = setupTest();
    await spend(t);
    const data = await refusal(ask(t));
    expect(data.code).toBe(TOO_MANY_CODES);
    expect(data.retryAfterMs).toBeGreaterThan(0);
    expect(data.retryAfterMs).toBeLessThanOrEqual(EMAIL_CODE_SEND_WINDOW_MS);
    expect(data.message).toMatch(/newest one/);
    expect(mailed).toHaveLength(EMAIL_CODE_SENDS_PER_ADDRESS);
  });

  test("a refused request leaves the newest code in the inbox working", async () => {
    // The library writes a new code before mailing it, replacing the last one.
    // Refused in that same transaction, the replacement never happens.
    const t = setupTest();
    await spend(t);
    const newest = mailed[mailed.length - 1]!.code;
    await refusal(ask(t));
    expect((await verify(t, newest)).tokens).not.toBeNull();
  });

  test("after the window, a code can be asked for again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    const t = setupTest();
    await spend(t);
    await refusal(ask(t));
    vi.setSystemTime(Date.now() + EMAIL_CODE_SEND_WINDOW_MS);
    await ask(t);
    expect(mailed).toHaveLength(EMAIL_CODE_SENDS_PER_ADDRESS + 1);
    // And the code it sent still lives its ten minutes and works once.
    const code = mailed[mailed.length - 1]!.code;
    expect((await verify(t, code)).tokens).not.toBeNull();
    await expect(verify(t, code)).rejects.toThrow(/Could not verify code/);
  });

  test("capital letters and spaces do not make a second budget", async () => {
    const t = setupTest();
    await spend(t);
    expect((await refusal(ask(t, "  Sends@Context.INVALID "))).code).toBe(TOO_MANY_CODES);
  });

  test("one address at its limit does not hold up anybody else", async () => {
    const t = setupTest();
    await spend(t);
    for (let i = 0; i < 20; i++) await ask(t, `other-${i}@context.invalid`);
    expect(mailed.filter((m) => m.to !== EMAIL)).toHaveLength(20);
  });

  test("requests fired together cannot overspend", async () => {
    const t = setupTest();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => ask(t)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(EMAIL_CODE_SENDS_PER_ADDRESS);
    expect(mailed).toHaveLength(EMAIL_CODE_SENDS_PER_ADDRESS);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    for (const r of refused) expect((r.reason as ConvexError<{ code: string }>).data.code).toBe(TOO_MANY_CODES);
  });

  test("a fresh code still does not reset the guess limit", async () => {
    const t = setupTest();
    const first = (await ask(t), mailed[mailed.length - 1]!.code);
    const wrong = first === "123456" ? "654321" : "123456";
    for (let guess = 0; guess < 10; guess++) await expect(verify(t, wrong)).rejects.toThrow(/Could not verify code/);
    await ask(t);
    await expect(verify(t, mailed[mailed.length - 1]!.code)).rejects.toThrow(/Could not verify code/);
  });

  test("the invitation link's code is not counted against the address", async () => {
    const t = setupTest();
    await spend(t);
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.auth.store, {
        args: {
          type: "createVerificationCode",
          provider: "magic-link",
          email: EMAIL,
          code: `invitation-code-${i}-${"x".repeat(32)}`,
          expirationTime: Date.now() + 60_000,
          allowExtraProviders: false,
        },
      });
    }
  });
});
