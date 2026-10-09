import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createUser, drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * SIGNING IN WITH A PHONE, THROUGH THE REAL SIGN-IN.
 *
 * Dev2 (2026-10-09): sign-in moves to phone numbers. What must hold: a phone
 * an account holds gets a texted code and only Twilio's "approved" signs in,
 * to that account and no other; a phone nobody holds is texted nothing and
 * makes no account (the page asks for an email instead); and texting and
 * guessing are both limited. Twilio is a fake `fetch`; the numbers are
 * reserved fiction.
 */

const ORIGIN = "https://context.test";
const KAYLA_PHONE = "+15555550100";
const NOBODY = "+15555550199";

type TwilioCall = { path: string; to: string | null };
let calls: TwilioCall[];
let goodCode: string;

beforeEach(async () => {
  calls = [];
  goodCode = "123456";
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_not_real");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token-not-real");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA_test_not_real");
  vi.stubEnv("SITE_URL", ORIGIN);
  vi.stubEnv("CONVEX_SITE_URL", ORIGIN);
  vi.stubEnv("OPEN_SIGNUP", "");
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("JWT_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.host !== "verify.twilio.com") throw new Error(`network access attempted: ${url}`);
    const body = new URLSearchParams(init?.body as URLSearchParams);
    calls.push({ path: url.pathname.split("/").pop()!, to: body.get("To") });
    if (url.pathname.endsWith("/Verifications")) return new Response(JSON.stringify({ status: "pending" }), { status: 201 });
    if (body.get("Code") !== goodCode) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ status: "approved", valid: true }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function kayla(t: TestConvex): Promise<Id<"users">> {
  const id = await createUser(t, "kayla@home.example");
  await t.run((ctx) => ctx.db.patch(id, { phone: KAYLA_PHONE, phoneVerificationTime: 1 }));
  return id;
}

const start = (t: TestConvex, phone: string) => t.action(api.functions.phoneSignIn.start, { phone });

async function signIn(t: TestConvex, phone: string, code: string) {
  const result = await t.action(api.auth.signIn, { provider: "phone-verify", params: { phone, code } });
  await drainScheduled(t);
  return result;
}

/** A refused credentials sign-in answers with no tokens rather than throwing. */
async function sessionUsers(t: TestConvex) {
  return await t.run(async (ctx) => (await ctx.db.query("authSessions").collect()).map((row) => row.userId));
}

describe("a phone an account holds", () => {
  test("is texted a code, typed any way, and the code signs in to that account", async () => {
    const t = setupTest();
    const id = await kayla(t);
    expect(await start(t, "+1 (555) 555-0100")).toEqual({ status: "sent", phone: KAYLA_PHONE });
    expect(calls).toEqual([{ path: "Verifications", to: KAYLA_PHONE }]);

    const result = await signIn(t, KAYLA_PHONE, goodCode);
    expect(result.tokens).toBeTruthy();
    expect(await sessionUsers(t)).toEqual([id]);
    expect(await t.run(async (ctx) => (await ctx.db.query("users").collect()).length)).toBe(1);
  });

  test("a phone linked for texting signs in too", async () => {
    const t = setupTest();
    const id = await createUser(t, "boss@work.example");
    await t.run((ctx) => ctx.db.insert("phoneLinks", { userId: id, phone: KAYLA_PHONE, linkedAt: 1 }));
    expect((await start(t, KAYLA_PHONE)).status).toBe("sent");
    await signIn(t, KAYLA_PHONE, goodCode);
    expect(await sessionUsers(t)).toEqual([id]);
  });

  test("a wrong code signs nobody in", async () => {
    const t = setupTest();
    await kayla(t);
    await start(t, KAYLA_PHONE);
    expect((await signIn(t, KAYLA_PHONE, "999999")).tokens).toBeNull();
    expect(await sessionUsers(t)).toEqual([]);
  });

  test("a phone on an account but never confirmed signs nobody in", async () => {
    const t = setupTest();
    const id = await createUser(t, "kayla@home.example");
    await t.run((ctx) => ctx.db.patch(id, { phone: KAYLA_PHONE }));
    expect((await start(t, KAYLA_PHONE)).status).toBe("new");
    expect((await signIn(t, KAYLA_PHONE, goodCode)).tokens).toBeNull();
    expect(await sessionUsers(t)).toEqual([]);
  });
});

describe("a phone nobody holds", () => {
  test("is texted nothing, and even an approved code makes no account", async () => {
    const t = setupTest();
    await kayla(t);
    expect(await start(t, NOBODY)).toEqual({ status: "new", phone: NOBODY });
    expect(calls).toEqual([]);
    expect((await signIn(t, NOBODY, goodCode)).tokens).toBeNull();
    expect(await sessionUsers(t)).toEqual([]);
    expect(await t.run(async (ctx) => (await ctx.db.query("users").collect()).length)).toBe(1);
  });
});

describe("limits", () => {
  test("five texts per phone an hour", async () => {
    const t = setupTest();
    await kayla(t);
    for (let i = 0; i < 5; i++) expect((await start(t, KAYLA_PHONE)).status).toBe("sent");
    expect((await start(t, KAYLA_PHONE)).status).toBe("too_many");
    expect(calls).toHaveLength(5);
  });

  test("ten code checks per phone an hour, then even the right code is refused before Twilio", async () => {
    const t = setupTest();
    const id = await kayla(t);
    for (let i = 0; i < 10; i++) expect((await signIn(t, KAYLA_PHONE, "999999")).tokens).toBeNull();
    const checked = calls.length;
    expect((await signIn(t, KAYLA_PHONE, goodCode)).tokens).toBeNull();
    expect(calls.length).toBe(checked);
    expect(await sessionUsers(t)).not.toContain(id);
  });

  test("a malformed number is refused, and without keys the page falls back to email", async () => {
    const t = setupTest();
    expect(await start(t, "555 0100")).toEqual({ status: "invalid_phone" });
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "");
    expect((await start(t, KAYLA_PHONE)).status).toBe("unavailable");
    expect(calls).toEqual([]);
  });
});
