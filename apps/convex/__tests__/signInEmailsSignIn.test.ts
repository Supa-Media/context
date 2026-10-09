import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser, createUser, drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * AN ADDED EMAIL, THROUGH THE REAL SIGN-IN.
 *
 * The whole path with the real auth providers: add an address on Account
 * settings with the code that is actually mailed, then sign in with that
 * address. It must land in the same account, keep mail on the main address,
 * and never make a second account — which is what the framework's
 * `findUserByEmail` hook and its "never replace an address" rule are for.
 * Resend is a fake that keeps each mailed code by recipient.
 */

const ORIGIN = "https://context.test";
let codes: Map<string, string>;

beforeEach(async () => {
  vi.stubEnv("RESEND_API_KEY", "re_fake_key_for_tests");
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  vi.stubEnv("SITE_URL", ORIGIN);
  vi.stubEnv("CONVEX_SITE_URL", ORIGIN);
  vi.stubEnv("OPEN_SIGNUP", "");
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("JWT_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  codes = new Map();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url !== "https://api.resend.com/emails") throw new Error(`network access attempted: ${url}`);
    const mail = JSON.parse(String(init?.body ?? "{}")) as { to: string | string[]; subject?: string };
    const code = /^(\d{6}) is your Context code$/.exec(mail.subject ?? "")?.[1];
    if (code !== undefined) codes.set(Array.isArray(mail.to) ? mail.to[0]! : mail.to, code);
    return new Response(JSON.stringify({ id: "fake" }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function signIn(t: TestConvex, email: string) {
  await t.action(api.auth.signIn, { provider: "email", params: { email } });
  const code = codes.get(email);
  expect(code).toBeDefined();
  await t.action(api.auth.signIn, { provider: "email", params: { email, code: code! } });
  await drainScheduled(t);
}

test("signing in with an added email lands in the same account, and mail stays put", async () => {
  const t = setupTest();
  const ada = await createUser(t, "ada@home.example");

  await asUser(t, ada).action(api.functions.signInEmails.startAddEmail, { email: "ada@work.example" });
  await drainScheduled(t);
  const added = codes.get("ada@work.example");
  expect(added).toBeDefined();
  expect(await asUser(t, ada).action(api.functions.signInEmails.confirmAddEmail, { code: added! })).toEqual({
    status: "added",
  });

  await signIn(t, "ada@work.example");

  const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
  expect(users.map((user) => user._id)).toEqual([ada]);
  expect(users[0]!.email).toBe("ada@home.example");
  const accounts = await t.run(async (ctx) => await ctx.db.query("authAccounts").collect());
  expect(accounts.map((account) => [account.providerAccountId, account.userId])).toContainEqual([
    "ada@work.example",
    ada,
  ]);
});

test("an address nobody added is still refused by the invite-only gate", async () => {
  const t = setupTest();
  await createUser(t, "ada@home.example");
  await expect(t.action(api.auth.signIn, { provider: "email", params: { email: "stranger@work.example" } })).rejects.toThrow();
  expect(codes.has("stranger@work.example")).toBe(false);
});
