import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { api, internal } from "../_generated/api";
import type { QueryCtx } from "../_generated/server";
import { setupTest, type TestConvex } from "./fixtures.helpers";
import {
  GOOGLE_REVIEW_EMAIL,
  MAX_REVIEWER_PASSWORD_MISSES,
  PASSWORD_ACCOUNTS,
  REVIEWER_PASSWORD_LIFETIME_MS,
  REVIEWER_PASSWORD_MISS_WINDOW_MS,
  REVIEWER_PASSWORD_PROVIDER_ID,
  YC_REVIEW_EMAIL,
  hashReviewerPassword,
  newReviewerPassword,
} from "../functions/lib/reviewerPassword";
import { REVIEWER_EMAIL, isReservedReviewer, mayHoldGoogleConnection } from "../functions/lib/reviewerAccount";

/**
 * The review accounts' staff-set passwords: YC's and Google's OAuth
 * verification reviewer's (owner, 2026-11-14; Google's approved 2026-11-18;
 * `functions/lib/reviewerPassword.ts`).
 *
 * Every check in the `describe.each` below runs once per password account.
 * They are held to the controls CASA holds a code to: random, never fixed,
 * stored only as a keyed hash, expiring, replaceable, revocable,
 * guess-limited, and opening only their own account. Driven through the
 * public `auth:signIn`, so a framework bump that drops the `credentials`
 * provider fails here.
 *
 * Sabotage checked:
 *  - `PASSWORD_ACCOUNTS` set back to `[YC_REVIEW_EMAIL]` → every Google case
 *    fails (set, sign-in, expiry, lockout), and "a password opens only the
 *    account it was set for" fails too.
 *  - `passwordAccount` answering any address → "is set only for the review
 *    accounts" fails.
 *  - The miss limit removed → "refuses everyone after ten wrong" fails.
 *  - The expiry check removed → "expires at thirty days" fails.
 *  - The salt dropped from `hashReviewerPassword` → "hash is salted and keyed"
 *    fails.
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

async function set(t: TestConvex, email: string) {
  return await t.mutation(internal.functions.reviewerPasswords.set, { email });
}

async function revoke(t: TestConvex, email: string) {
  return await t.mutation(internal.functions.reviewerPasswords.revoke, { email });
}

async function signIn(t: TestConvex, email: string, password: string) {
  return await t.action(api.auth.signIn, { provider: P, params: { email, password } });
}

async function rowsOf(t: TestConvex) {
  return await t.run((ctx) => ctx.db.query("reviewerPasswords").collect());
}

function wrongFor(password: string): string {
  let wrong = newReviewerPassword();
  while (wrong === password) wrong = newReviewerPassword();
  return wrong;
}

describe.each([YC_REVIEW_EMAIL, GOOGLE_REVIEW_EMAIL])("the %s review password", (account) => {
  test("is random, 20 characters, and signs the account in more than once", async () => {
    const t = setupTest();
    const { password, email } = await set(t, account);
    expect(email).toBe(account);
    expect(password).toMatch(/^[A-Za-z2-9]{20}$/);
    expect((await signIn(t, account, password)).tokens).toBeTruthy();
    expect((await signIn(t, ` ${account.toUpperCase()} `, password)).tokens).toBeTruthy();
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users.map((user) => user.email)).toEqual([account]);
  });

  test("is stored only as a hash", async () => {
    const t = setupTest();
    const { password } = await set(t, account);
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(password);
    expect(rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("setting another replaces it, and reuses the account", async () => {
    const t = setupTest();
    const first = await set(t, account);
    const second = await set(t, account);
    expect(second.password).not.toBe(first.password);
    expect((await signIn(t, account, first.password)).tokens).toBeNull();
    expect((await signIn(t, account, second.password)).tokens).toBeTruthy();
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(1);
    expect(await rowsOf(t)).toHaveLength(1);
  });

  test("revoking ends it", async () => {
    const t = setupTest();
    const { password } = await set(t, account);
    expect(await revoke(t, account)).toEqual({ revoked: 1 });
    expect((await signIn(t, account, password)).tokens).toBeNull();
  });

  test("expires at thirty days, including the boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const { password, expiresAt } = await set(t, account);
    expect(expiresAt - Date.now()).toBe(REVIEWER_PASSWORD_LIFETIME_MS);
    vi.setSystemTime(expiresAt - 1);
    expect((await signIn(t, account, password)).tokens).toBeTruthy();
    vi.setSystemTime(expiresAt);
    expect((await signIn(t, account, password)).tokens).toBeNull();
    expect(await rowsOf(t)).toEqual([]);
  });

  test(`refuses everyone after ${MAX_REVIEWER_PASSWORD_MISSES} wrong in an hour, then opens again`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const { password } = await set(t, account);
    const wrong = wrongFor(password);
    for (let miss = 0; miss < MAX_REVIEWER_PASSWORD_MISSES; miss++) {
      expect((await signIn(t, account, wrong)).tokens).toBeNull();
    }
    expect((await signIn(t, account, password)).tokens).toBeNull();
    // Wrong guesses never delete it: the address is public.
    expect(await rowsOf(t)).toHaveLength(1);
    vi.setSystemTime(Date.now() + REVIEWER_PASSWORD_MISS_WINDOW_MS);
    expect((await signIn(t, account, password)).tokens).toBeTruthy();
  });

  test("opens only its own account", async () => {
    const t = setupTest();
    const { password } = await set(t, account);
    const others = [
      REVIEWER_EMAIL,
      "stranger@example.invalid",
      `${account}.evil.test`,
      ...PASSWORD_ACCOUNTS.filter((email) => email !== account),
    ];
    for (const email of others) {
      expect((await signIn(t, email, password)).tokens).toBeNull();
    }
    // Not through any other provider either.
    await expect(t.action(api.auth.signIn, { provider: "email", params: { email: account, code: password } })).rejects.toThrow();
  });

  test("refuses with nothing set, a malformed password, or a missing account", async () => {
    const t = setupTest();
    expect((await signIn(t, account, newReviewerPassword())).tokens).toBeNull();
    const { password } = await set(t, account);
    await expect(t.action(api.auth.signIn, { provider: P, params: { email: account } })).resolves.toMatchObject({ tokens: null });
    expect((await signIn(t, account, `${password}x`)).tokens).toBeNull();
    await t.run(async (ctx) => {
      for (const user of await ctx.db.query("users").collect()) await ctx.db.delete(user._id);
    });
    expect((await signIn(t, account, password)).tokens).toBeNull();
  });
});

describe("is set only for the review accounts", () => {
  test("REVIEWER_EMAIL and a customer are refused, to set or revoke", async () => {
    const t = setupTest();
    for (const email of [REVIEWER_EMAIL, "customer@example.invalid"]) {
      await expect(t.mutation(internal.functions.reviewerPasswords.set, { email })).rejects.toThrow(/only for the review accounts/);
      await expect(t.mutation(internal.functions.reviewerPasswords.revoke, { email })).rejects.toThrow(/only for the review accounts/);
    }
  });
});

describe("a password opens only the account it was set for", () => {
  test("each opens its own account, and never the other's", async () => {
    const t = setupTest();
    const yc = await set(t, YC_REVIEW_EMAIL);
    const google = await set(t, GOOGLE_REVIEW_EMAIL);
    expect((await signIn(t, GOOGLE_REVIEW_EMAIL, yc.password)).tokens).toBeNull();
    expect((await signIn(t, YC_REVIEW_EMAIL, google.password)).tokens).toBeNull();
    expect((await signIn(t, YC_REVIEW_EMAIL, yc.password)).tokens).toBeTruthy();
    expect((await signIn(t, GOOGLE_REVIEW_EMAIL, google.password)).tokens).toBeTruthy();
  });

  test("revoking Google's leaves YC's working", async () => {
    const t = setupTest();
    const yc = await set(t, YC_REVIEW_EMAIL);
    const google = await set(t, GOOGLE_REVIEW_EMAIL);
    expect(await revoke(t, GOOGLE_REVIEW_EMAIL)).toEqual({ revoked: 1 });
    expect((await signIn(t, GOOGLE_REVIEW_EMAIL, google.password)).tokens).toBeNull();
    expect((await signIn(t, YC_REVIEW_EMAIL, yc.password)).tokens).toBeTruthy();
  });

  test("Google's lockout leaves YC's working", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const yc = await set(t, YC_REVIEW_EMAIL);
    const google = await set(t, GOOGLE_REVIEW_EMAIL);
    const wrong = wrongFor(google.password);
    for (let miss = 0; miss < MAX_REVIEWER_PASSWORD_MISSES; miss++) {
      expect((await signIn(t, GOOGLE_REVIEW_EMAIL, wrong)).tokens).toBeNull();
    }
    expect((await signIn(t, GOOGLE_REVIEW_EMAIL, google.password)).tokens).toBeNull();
    expect((await signIn(t, YC_REVIEW_EMAIL, yc.password)).tokens).toBeTruthy();
  });
});

describe("the hash is salted and keyed", () => {
  test("two sets of the same account draw different salts", async () => {
    const t = setupTest();
    await set(t, GOOGLE_REVIEW_EMAIL);
    const [first] = await rowsOf(t);
    await set(t, GOOGLE_REVIEW_EMAIL);
    const [second] = await rowsOf(t);
    expect(first!.salt).not.toBe(second!.salt);
    expect(first!.hash).not.toBe(second!.hash);
  });

  test("both accounts' rows draw different salts", async () => {
    const t = setupTest();
    await set(t, YC_REVIEW_EMAIL);
    await set(t, GOOGLE_REVIEW_EMAIL);
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.salt).not.toBe(rows[1]!.salt);
  });

  for (const account of [YC_REVIEW_EMAIL, GOOGLE_REVIEW_EMAIL]) {
    test(`${account}'s hash is an HMAC under the key, not a plain digest`, async () => {
      const t = setupTest();
      const { password } = await set(t, account);
      const [row] = await rowsOf(t);
      const plain = createHash("sha256").update(`${account}:${row!.salt}:${password}`).digest("hex");
      expect(row!.hash).not.toBe(plain);
      expect(row!.hash).toBe(await hashReviewerPassword(account, row!.salt, password));
    });

    test(`${account}'s hash changes when the key does`, async () => {
      const t = setupTest();
      const { password } = await set(t, account);
      const [row] = await rowsOf(t);
      vi.stubEnv("AUTH_CODE_HASH_KEY", "other-key");
      expect(await hashReviewerPassword(account, row!.salt, password)).not.toBe(row!.hash);
    });
  }

  test("no row holds a plaintext password", async () => {
    const t = setupTest();
    const yc = await set(t, YC_REVIEW_EMAIL);
    const google = await set(t, GOOGLE_REVIEW_EMAIL);
    const dump = JSON.stringify(await rowsOf(t));
    expect(dump).not.toContain(yc.password);
    expect(dump).not.toContain(google.password);
  });
});

describe("the Google review account's reach", () => {
  test("google-review stays in its own workspace and may hold a Google connection; YC's may not", async () => {
    const t = setupTest();
    await set(t, GOOGLE_REVIEW_EMAIL);
    await set(t, YC_REVIEW_EMAIL);
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    const idOf = (email: string) => users.find((user) => user.email === email)!._id;
    const reach = await t.run(async (ctx) => {
      const ask = (email: string) => {
        const userId = idOf(email);
        return Promise.all([isReservedReviewer(ctx as QueryCtx, userId), mayHoldGoogleConnection(ctx as QueryCtx, userId)]);
      };
      return { google: await ask(GOOGLE_REVIEW_EMAIL), yc: await ask(YC_REVIEW_EMAIL) };
    });
    expect(reach.google).toEqual([true, true]);
    expect(reach.yc).toEqual([true, false]);
  });
});
