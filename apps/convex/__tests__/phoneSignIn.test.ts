import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, createUser, createWorkspace, drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";

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
/** Codes mailed by the fake Resend, by recipient. */
let mailed: Map<string, string>;

beforeEach(async () => {
  calls = [];
  goodCode = "123456";
  mailed = new Map();
  vi.stubEnv("RESEND_API_KEY", "re_fake_key_for_tests");
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
    if (url.host === "api.resend.com") {
      const mail = JSON.parse(String(init?.body ?? "{}")) as { to: string | string[]; subject?: string };
      const code = /^(\d{6}) is your Context code$/.exec(mail.subject ?? "")?.[1];
      if (code !== undefined) mailed.set(Array.isArray(mail.to) ? mail.to[0]! : mail.to, code);
      return new Response(JSON.stringify({ id: "fake" }), { status: 200 });
    }
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
    expect((await start(t, KAYLA_PHONE)).status).toBe("joined");
    expect((await signIn(t, KAYLA_PHONE, goodCode)).tokens).toBeNull();
    expect(await sessionUsers(t)).toEqual([]);
  });
});

describe("a phone nobody holds", () => {
  test("joins the waitlist, is texted nothing, and even an approved code makes no account", async () => {
    const t = setupTest();
    await kayla(t);
    expect(await start(t, NOBODY)).toEqual({ status: "joined", phone: NOBODY });
    expect(await start(t, NOBODY)).toEqual({ status: "already", phone: NOBODY });
    expect(calls).toEqual([]);
    const rows = await t.run(async (ctx) => await ctx.db.query("waitlist").collect());
    expect(rows.map((row) => [row.phone, row.email, row.status])).toEqual([[NOBODY, undefined, "waiting"]]);
    expect((await signIn(t, NOBODY, goodCode)).tokens).toBeNull();
    expect(await sessionUsers(t)).toEqual([]);
    expect(await t.run(async (ctx) => (await ctx.db.query("users").collect()).length)).toBe(1);
  });

  test("a removed row reads like a waiting one and is still texted nothing", async () => {
    const t = setupTest();
    await t.run((ctx) => ctx.db.insert("waitlist", { phone: NOBODY, status: "removed", joinedAt: 1, source: "login" }));
    expect((await start(t, NOBODY)).status).toBe("already");
    expect(calls).toEqual([]);
  });
});

describe("which landing page a phone was joined from", () => {
  test("is stored on the new waitlist row, and an invalid one is dropped", async () => {
    const t = setupTest();
    expect(await t.action(api.functions.phoneSignIn.start, { phone: NOBODY, landing: "d" })).toEqual({
      status: "joined",
      phone: NOBODY,
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("waitlist").withIndex("by_phone", (q) => q.eq("phone", NOBODY)).collect();
      expect(rows.map((row) => row.landing)).toEqual(["d"]);
    });
    const other = "+15555550188";
    expect(await t.action(api.functions.phoneSignIn.start, { phone: other, landing: "<b>" })).toEqual({
      status: "joined",
      phone: other,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("waitlist").withIndex("by_phone", (q) => q.eq("phone", other)).unique();
      expect(row?.landing).toBeUndefined();
    });
  });
});

describe("a phone staff let in", () => {
  test("is texted a code, and the code makes its account with the phone confirmed", async () => {
    const t = setupTest();
    await t.run((ctx) => ctx.db.insert("waitlist", { phone: NOBODY, status: "admitted", joinedAt: 1, source: "login" }));
    expect((await start(t, NOBODY)).status).toBe("sent");
    expect((await signIn(t, NOBODY, "999999")).tokens).toBeNull();
    expect(await t.run(async (ctx) => (await ctx.db.query("users").collect()).length)).toBe(0);

    expect((await signIn(t, NOBODY, goodCode)).tokens).toBeTruthy();
    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ phone: NOBODY });
    expect(users[0]!.phoneVerificationTime).toBeTypeOf("number");
    expect(users[0]!.email).toBeUndefined();
    expect(await sessionUsers(t)).toEqual([users[0]!._id]);

    // The next sign-in lands in the same account rather than making another.
    await signIn(t, NOBODY, goodCode);
    expect(await t.run(async (ctx) => (await ctx.db.query("users").collect()).length)).toBe(1);
    expect(await asUser(t, users[0]!._id).query(api.functions.phoneCheck.myPhoneCheck, {})).toMatchObject({
      confirmed: true,
      needsEmail: true,
    });
  });
});

/** A phone account made by a let-in phone, signed in. */
async function newcomer(t: TestConvex): Promise<Id<"users">> {
  await t.run((ctx) => ctx.db.insert("waitlist", { phone: NOBODY, status: "admitted", joinedAt: 1, source: "login" }));
  await signIn(t, NOBODY, goodCode);
  const users = await t.run(async (ctx) => await ctx.db.query("users").withIndex("by_phone", (q) => q.eq("phone", NOBODY)).collect());
  return users[0]!._id;
}

async function addEmail(t: TestConvex, userId: Id<"users">, email: string) {
  const started = await asUser(t, userId).action(api.functions.signInEmails.startAddEmail, { email });
  if (started.status !== "sent") return started.status;
  await drainScheduled(t);
  const code = mailed.get(email);
  expect(code).toBeDefined();
  return (await asUser(t, userId).action(api.functions.signInEmails.confirmAddEmail, { code: code! })).status;
}

describe("the email a phone account is asked for", () => {
  test("a new address becomes where mail goes, and the question stops", async () => {
    const t = setupTest();
    const id = await newcomer(t);
    expect(await addEmail(t, id, "jordan@work.example")).toBe("added");
    const user = await t.run(async (ctx) => await ctx.db.get(id));
    expect(user?.email).toBe("jordan@work.example");
    expect(user?.emailVerificationTime).toBeTypeOf("number");
    expect(await t.run(async (ctx) => await ctx.db.query("signInEmails").collect())).toEqual([]);
    expect(await asUser(t, id).query(api.functions.phoneCheck.myPhoneCheck, {})).toMatchObject({ needsEmail: false });
  });

  test("an address that already has Context: the phone moves there, and signs in there next time", async () => {
    const t = setupTest();
    const old = await createUser(t, "jordan@home.example");
    await createWorkspace(t, old, "jordan", { kind: "personal" });
    const id = await newcomer(t);
    expect(await addEmail(t, id, "jordan@home.example")).toBe("moved");
    await t.run(async (ctx) => {
      expect(await ctx.db.get(id)).toBeNull();
      expect(await ctx.db.get(old)).toMatchObject({ phone: NOBODY, email: "jordan@home.example" });
    });
    await signIn(t, NOBODY, goodCode);
    expect((await sessionUsers(t)).at(-1)).toBe(old);
    expect(await t.run(async (ctx) => (await ctx.db.query("users").collect()).length)).toBe(1);
  });

  test("never into an account that signs in with another phone, nor from an account that has one", async () => {
    const t = setupTest();
    const old = await kayla(t);
    await createWorkspace(t, old, "kayla", { kind: "personal" });
    const id = await newcomer(t);
    expect(await addEmail(t, id, "kayla@home.example")).toBe("has_own_workspace");
    expect(mailed.has("kayla@home.example")).toBe(false);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(id)).not.toBeNull();
      expect((await ctx.db.get(old))?.phone).toBe(KAYLA_PHONE);
    });
    // An account that already has an email is not a newcomer, phone or not.
    const other = await createUser(t, "sam@home.example");
    await t.run((ctx) => ctx.db.patch(other, { phone: "+15555550177", phoneVerificationTime: 1 }));
    const jordan = await createUser(t, "jordan@home.example");
    await createWorkspace(t, jordan, "jordan", { kind: "personal" });
    expect(await addEmail(t, other, "jordan@home.example")).toBe("has_own_workspace");
  });
});

describe("a phone that has changed hands", () => {
  /**
   * Texting a code back from the number is the strongest claim the product
   * recognises: `consumeLinkCode` moves a `phoneLinks` row off whoever had it
   * ("whoever texted the code holds the phone"). Sign-in has to read the same
   * claim, or the new holder of a recycled number signs in to the account that
   * confirmed it first — one account reaching another.
   */
  test("signs in to the account holding it now, not the one that confirmed it first", async () => {
    const t = setupTest();
    const first = await kayla(t);
    const holder = await createUser(t, "boss@work.example");
    await createWorkspace(t, holder, "boss", { kind: "personal" });
    const { code } = await asUser(t, holder).action(api.functions.textLinks.startPhoneLink, { phone: KAYLA_PHONE });
    expect(
      await t.mutation(internal.functions.textLinks.consumeLinkCode, {
        phone: KAYLA_PHONE,
        hashedCode: await hashToken(code),
      }),
    ).toMatchObject({ status: "linked" });

    expect((await start(t, KAYLA_PHONE)).status).toBe("sent");
    await signIn(t, KAYLA_PHONE, goodCode);
    expect(await sessionUsers(t)).toEqual([holder]);
    expect(await sessionUsers(t)).not.toContain(first);
  });

  test("one phone is one account: linking it clears the confirmation it had elsewhere", async () => {
    const t = setupTest();
    const first = await kayla(t);
    const holder = await createUser(t, "boss@work.example");
    await createWorkspace(t, holder, "boss", { kind: "personal" });
    const { code } = await asUser(t, holder).action(api.functions.textLinks.startPhoneLink, { phone: KAYLA_PHONE });
    await t.mutation(internal.functions.textLinks.consumeLinkCode, {
      phone: KAYLA_PHONE,
      hashedCode: await hashToken(code),
    });
    await t.run(async (ctx) => {
      const stale = await ctx.db.get(first);
      expect(stale?.phone).toBeUndefined();
      expect(stale?.phoneVerificationTime).toBeUndefined();
    });
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
