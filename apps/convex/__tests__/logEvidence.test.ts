import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser, seedAppSecret, setupTest, type TestConvex } from "./fixtures.helpers";
import { STRIPE_API_KEY_SECRET, STRIPE_PRICE_ID_ENV_VAR } from "../functions/lib/premium";
import { FAKE_PRICE_ID, SIGNING_SECRET, chooseBoth, context, postWebhook } from "./billing/fixtures.helpers";

/**
 * What the deployment's own logs say about a sign-in and a payment, as a
 * security assessment asks for it: which fields a log line carries, and that
 * no credential, sign-in code, session token, address or payment detail is
 * among them.
 *
 * LOCAL TEST EVIDENCE, NOT A PRODUCTION LOG SAMPLE. Every line asserted here
 * was printed by the real sign-in code (`@supa-media/convex/auth`, the
 * patched `@convex-dev/auth`) and the real Stripe code (`http.ts`,
 * `billingStripe.ts`) running under convex-test, with Resend and Stripe
 * stubbed and every value fake. Set `LOG_EVIDENCE_OUT` to a file path and the
 * captured lines are written there, so the sample handed to an assessor is the
 * one this test checked.
 *
 * What this cannot show, and does not claim to: the deployment's settings.
 * One framework branch prints a code and an address if a setting is wrong,
 * and a test below drives it to say so plainly rather than leave it out: with
 * no RESEND_API_KEY the email code is printed instead of mailed. A Resend
 * refusal used to print Resend's own response body; since
 * `@supa-media/convex` 1.11.2 it is a status and a known error name only, and
 * the test below feeds it a body that echoes the address, the code and the
 * key.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   `stripe.checkout_failed` also printing Stripe's message and the session   1
 *   the framework's Resend error line also printing the code                  1
 */

const EMAIL = "log-evidence@context.invalid";
const RESEND_KEY = "re_test_log_evidence_not_real";
const STRIPE_KEY = "sk_test_log_evidence_not_real";
const ENV_KEYS = ["RESEND_API_KEY", "SITE_URL", "CONVEX_SITE_URL", "JWT_PRIVATE_KEY", "OPEN_SIGNUP"] as const;

type Line = { level: string; text: string };
let lines: Line[];
let previous: Map<string, string | undefined>;
let realFetch: typeof globalThis.fetch;
let mailed: string[];
let resendAnswer: () => Response;
let stripeAnswer: () => Response;
const evidence: Array<{ case: string; lines: Line[] }> = [];

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

beforeEach(async () => {
  lines = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push({ level, text: args.map(render).join(" ") });
    });
  }
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.RESEND_API_KEY = RESEND_KEY;
  process.env.OPEN_SIGNUP = "true";
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.JWT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.SITE_URL = "https://context.invalid";
  process.env.CONVEX_SITE_URL = "https://context.invalid";
  mailed = [];
  resendAnswer = () => new Response(JSON.stringify({ id: "email_test" }), { status: 200 });
  stripeAnswer = () =>
    new Response(JSON.stringify({ error: { type: "card_error", code: "card_declined", message: "Your card was declined." } }), { status: 402 });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.resend.com/emails") {
      const subject = JSON.parse(String(init?.body)).subject as string;
      mailed.push(subject.slice(0, subject.indexOf(" ")));
      return resendAnswer();
    }
    if (url.startsWith("https://api.stripe.com/")) return stripeAnswer();
    throw new Error(`network access attempted: ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const key of ENV_KEYS) {
    const was = previous.get(key);
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  const out = process.env.LOG_EVIDENCE_OUT;
  if (out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(out, `${JSON.stringify({ label: "LOCAL TEST EVIDENCE (convex-test, fake values), not production logs", cases: evidence }, null, 2)}\n`);
  }
});

function keep(name: string) {
  evidence.push({ case: name, lines: [...lines] });
}

/** None of these may appear in any line. */
function expectNoneOf(secrets: string[]) {
  const all = lines.map((line) => line.text).join("\n");
  for (const secret of secrets) if (secret.length > 0) expect(all).not.toContain(secret);
}

async function requestCode(t: TestConvex): Promise<string> {
  await t.action(api.auth.signIn, { provider: "email", params: { email: EMAIL } });
  return mailed[mailed.length - 1]!;
}

function verify(t: TestConvex, code: string) {
  return t.action(api.auth.signIn, { provider: "email", params: { email: EMAIL, code } });
}

describe("sign-in log lines carry no code, token, key or address", () => {
  test("a code mailed, a wrong guess, the guess limit, then a sign-in and a refresh", async () => {
    const t = setupTest();
    const first = await requestCode(t);
    const wrong = first === "123456" ? "654321" : "123456";
    for (let guess = 0; guess < 10; guess++) await expect(verify(t, wrong)).rejects.toThrow(/Could not verify code/);
    await expect(verify(t, first)).rejects.toThrow(/Could not verify code/);

    const fresh = setupTest();
    const code = await requestCode(fresh);
    const result = await verify(fresh, code);
    const tokens = result.tokens!;
    expect(tokens).not.toBeNull();
    const refreshed = await fresh.action(api.auth.signIn, { refreshToken: tokens.refreshToken });
    keep("email code: request, 10 wrong guesses, lockout, sign-in, refresh");

    expect(lines.some((line) => line.text.includes("Too many failed attempts"))).toBe(true);
    expectNoneOf([
      first, code, wrong, EMAIL, RESEND_KEY,
      tokens.token, tokens.refreshToken,
      refreshed.tokens?.token ?? "", refreshed.tokens?.refreshToken ?? "",
      process.env.JWT_PRIVATE_KEY!.split("\n")[1]!,
    ]);
  });

  test("Resend refusing a send with a body that echoes the address, code and key: only a status and an error name are logged", async () => {
    const t = setupTest();
    resendAnswer = () => {
      const code = mailed[mailed.length - 1]!;
      return new Response(
        JSON.stringify({ statusCode: 429, name: "rate_limit_exceeded", message: `Too many requests for ${EMAIL} (${code}) with ${RESEND_KEY}.` }),
        { status: 429 },
      );
    };
    await expect(t.action(api.auth.signIn, { provider: "email", params: { email: EMAIL } })).rejects.toThrow();
    keep("email code: Resend refuses the send, its body echoing the address, code and key");
    const code = mailed[mailed.length - 1]!;
    expect(lines.some((line) => line.text === 'Resend email send failed {"status":429,"category":"rate_limit_exceeded"}')).toBe(true);
    expectNoneOf([code, RESEND_KEY, EMAIL]);
  });

  test("with no RESEND_API_KEY the framework prints the address and the code: a setting, not a log format", async () => {
    // Printed so a self-hoster with no mail can sign in. It is why production
    // must carry the key; this test exists so the evidence says so rather
    // than leaving the branch out.
    delete process.env.RESEND_API_KEY;
    const t = setupTest();
    await t.action(api.auth.signIn, { provider: "email", params: { email: EMAIL } });
    keep("email code: RESEND_API_KEY unset (misconfiguration)");
    const all = lines.map((line) => line.text).join("\n");
    expect(all).toContain("OTP CODE (no RESEND_API_KEY)");
    expect(all).toContain(EMAIL);
    expect(all).toMatch(/Code: \d{6}/);
  });
});

describe("payment log lines carry a status and nothing about the customer", () => {
  test("Stripe refusing a checkout: the line is an event name and an HTTP status", async () => {
    const t = setupTest();
    await seedAppSecret(t, STRIPE_API_KEY_SECRET, STRIPE_KEY);
    vi.stubEnv(STRIPE_PRICE_ID_ENV_VAR, FAKE_PRICE_ID);
    vi.stubEnv("APP_ORIGIN", "https://context.invalid");
    const { owner, workspaceId } = await context(t, "log-evidence-checkout");
    await chooseBoth(t, owner, workspaceId);
    const { sessionId } = await asUser(t, owner).mutation(api.functions.billing.startCheckout, { workspaceId });
    await t.action(internal.functions.billingStripe.createCheckoutSession, { sessionId });
    keep("stripe: checkout refused by Stripe");
    const failure = lines.find((line) => line.text.startsWith("stripe.checkout_failed"));
    expect(failure?.text).toBe('stripe.checkout_failed {"status":402}');
    expectNoneOf([STRIPE_KEY, "card_declined", "Your card was declined", "log-evidence-checkout-owner@example.invalid", String(workspaceId)]);
  });

  test("a signed webhook carrying card and customer details logs none of them; a forged one logs nothing", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    const event = {
      id: "evt_fake_log_evidence",
      object: "event",
      type: "customer.subscription.updated",
      created: 1_780_000_000,
      data: {
        object: {
          id: "sub_FAKE_LOG_EVIDENCE",
          object: "subscription",
          customer: "cus_FAKE_LOG_EVIDENCE",
          status: "active",
          customer_email: "payer@example.invalid",
          default_payment_method: { card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030, fingerprint: "fp_FAKE" } },
        },
      },
    };
    expect((await postWebhook(t, event)).status).toBe(200);
    expect((await postWebhook(t, event, { secret: "whsec_a_different_fake_secret" })).status).toBe(401);
    keep("stripe: signed and forged webhook deliveries");
    expectNoneOf([
      SIGNING_SECRET, "whsec_a_different_fake_secret", "payer@example.invalid", "4242", "fp_FAKE",
      "cus_FAKE_LOG_EVIDENCE", "sub_FAKE_LOG_EVIDENCE",
    ]);
  });
});
