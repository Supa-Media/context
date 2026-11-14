import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { setupTest, type TestConvex } from "./fixtures.helpers";
import {
  MAX_REVIEWER_PASSWORD_MISSES,
  REVIEWER_PASSWORD_LIFETIME_MS,
  REVIEWER_PASSWORD_MISS_WINDOW_MS,
  REVIEWER_PASSWORD_PROVIDER_ID,
  YC_REVIEW_EMAIL,
  newReviewerPassword,
} from "../functions/lib/reviewerPassword";
import { REVIEWER_EMAIL } from "../functions/lib/reviewerAccount";

/**
 * The YC review account's staff-set password (owner, 2026-11-14;
 * `functions/lib/reviewerPassword.ts`).
 *
 * Held to the controls CASA holds a code to: random, never fixed, stored only
 * as a keyed hash, expiring, replaceable, revocable, guess-limited, and
 * opening only its own account. Driven through the public `auth:signIn`, so a
 * framework bump that drops the `credentials` provider fails here.
 *
 * Sabotage checked: `passwordAccount` answering any address → "is set only
 * for the review accounts" fails; the miss limit removed → "refuses everyone after ten
 * wrong" fails; the expiry check removed → "expires at thirty days" fails.
 */

const P = REVIEWER_PASSWORD_PROVIDER_ID;

beforeEach(async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("JWT_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  vi.stubEnv("AUTH_CODE_HASH_KEY", "");
  vi.stubEnv("SITE_URL", "https://context.invalid");
  vi.stubEnv("CONVEX_SITE_URL", "https://context.invalid");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function set(t: TestConvex) {
  return await t.mutation(internal.functions.reviewerPasswords.set, { email: YC_REVIEW_EMAIL });
}

async function signIn(t: TestConvex, email: string, password: string) {
  return await t.action(api.auth.signIn, { provider: P, params: { email, password } });
}

function wrongFor(password: string): string {
  let wrong = newReviewerPassword();
  while (wrong === password) wrong = newReviewerPassword();
  return wrong;
}

describe("the YC review password", () => {
  test("is random, 20 characters, and signs the account in more than once", async () => {
    const t = setupTest();
    const { password, email } = await set(t);
    expect(email).toBe(YC_REVIEW_EMAIL);
    expect(password).toMatch(/^[A-Za-z2-9]{20}$/);
    expect((await signIn(t, YC_REVIEW_EMAIL, password)).tokens).toBeTruthy();
    expect((await signIn(t, " YC-Review@Supa.Media ", password)).tokens).toBeTruthy();
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users.map((user) => user.email)).toEqual([YC_REVIEW_EMAIL]);
  });

  test("is stored only as a hash", async () => {
    const t = setupTest();
    const { password } = await set(t);
    const rows = await t.run((ctx) => ctx.db.query("reviewerPasswords").collect());
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(password);
    expect(rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("setting another replaces it, and reuses the account", async () => {
    const t = setupTest();
    const first = await set(t);
    const second = await set(t);
    expect(second.password).not.toBe(first.password);
    expect((await signIn(t, YC_REVIEW_EMAIL, first.password)).tokens).toBeNull();
    expect((await signIn(t, YC_REVIEW_EMAIL, second.password)).tokens).toBeTruthy();
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("reviewerPasswords").collect())).toHaveLength(1);
  });

  test("revoking ends it", async () => {
    const t = setupTest();
    const { password } = await set(t);
    expect(await t.mutation(internal.functions.reviewerPasswords.revoke, { email: YC_REVIEW_EMAIL })).toEqual({ revoked: 1 });
    expect((await signIn(t, YC_REVIEW_EMAIL, password)).tokens).toBeNull();
  });

  test("expires at thirty days, including the boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const { password, expiresAt } = await set(t);
    expect(expiresAt - Date.now()).toBe(REVIEWER_PASSWORD_LIFETIME_MS);
    vi.setSystemTime(expiresAt - 1);
    expect((await signIn(t, YC_REVIEW_EMAIL, password)).tokens).toBeTruthy();
    vi.setSystemTime(expiresAt);
    expect((await signIn(t, YC_REVIEW_EMAIL, password)).tokens).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("reviewerPasswords").collect())).toEqual([]);
  });

  test(`refuses everyone after ${MAX_REVIEWER_PASSWORD_MISSES} wrong in an hour, then opens again`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const { password } = await set(t);
    const wrong = wrongFor(password);
    for (let miss = 0; miss < MAX_REVIEWER_PASSWORD_MISSES; miss++) {
      expect((await signIn(t, YC_REVIEW_EMAIL, wrong)).tokens).toBeNull();
    }
    expect((await signIn(t, YC_REVIEW_EMAIL, password)).tokens).toBeNull();
    // Wrong guesses never delete it: the address is public.
    expect(await t.run((ctx) => ctx.db.query("reviewerPasswords").collect())).toHaveLength(1);
    vi.setSystemTime(Date.now() + REVIEWER_PASSWORD_MISS_WINDOW_MS);
    expect((await signIn(t, YC_REVIEW_EMAIL, password)).tokens).toBeTruthy();
  });

  test("opens only its own account", async () => {
    const t = setupTest();
    const { password } = await set(t);
    for (const email of [REVIEWER_EMAIL, "stranger@example.invalid", "yc-review@supa.media.evil.test"]) {
      expect((await signIn(t, email, password)).tokens).toBeNull();
    }
    // Not through any other provider either.
    await expect(t.action(api.auth.signIn, { provider: "email", params: { email: YC_REVIEW_EMAIL, code: password } })).rejects.toThrow();
  });

  test("refuses with nothing set, a malformed password, or a missing account", async () => {
    const t = setupTest();
    expect((await signIn(t, YC_REVIEW_EMAIL, newReviewerPassword())).tokens).toBeNull();
    const { password } = await set(t);
    await expect(t.action(api.auth.signIn, { provider: P, params: { email: YC_REVIEW_EMAIL } })).resolves.toMatchObject({ tokens: null });
    expect((await signIn(t, YC_REVIEW_EMAIL, `${password}x`)).tokens).toBeNull();
    await t.run(async (ctx) => {
      for (const user of await ctx.db.query("users").collect()) await ctx.db.delete(user._id);
    });
    expect((await signIn(t, YC_REVIEW_EMAIL, password)).tokens).toBeNull();
  });

  test("is set only for the review accounts", async () => {
    const t = setupTest();
    for (const email of [REVIEWER_EMAIL, "customer@example.invalid"]) {
      await expect(t.mutation(internal.functions.reviewerPasswords.set, { email })).rejects.toThrow(/only for the review accounts/);
      await expect(t.mutation(internal.functions.reviewerPasswords.revoke, { email })).rejects.toThrow(/only for the review accounts/);
    }
  });
});
