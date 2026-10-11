import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, createUser, drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";
import { codeText, newCode } from "../functions/phoneCodes";
import { smsKeysWithSender } from "../functions/lib/adminFns/signInTexts";

/**
 * SIGN-IN CODES IN CONTEXT'S OWN WORDS.
 *
 * Twilio Verify signed codes "Your togather verification code" (the service is
 * shared) and refused a per-text name, so with a Messaging Service configured
 * Context texts and checks the code itself (Dev2, 2026-10-09). What must hold:
 * the text says Context and Verify is never asked; only the code last texted
 * signs in, once, within ten minutes, with five wrong tries; and a code Verify
 * sent before the switch still checks through Verify. Twilio is a fake
 * `fetch`; the numbers are reserved fiction.
 */

const ORIGIN = "https://context.test";
const PHONE = "+15555550100";

type Call = { host: string; path: string; body: URLSearchParams };
let calls: Call[];

beforeEach(async () => {
  calls = [];
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_not_real");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token-not-real");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA_test_not_real");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG_test_not_real");
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  vi.stubEnv("SITE_URL", ORIGIN);
  vi.stubEnv("CONVEX_SITE_URL", ORIGIN);
  vi.stubEnv("PHONE_CHECK", "required");
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("JWT_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = new URLSearchParams(init?.body as URLSearchParams);
    calls.push({ host: url.host, path: url.pathname, body });
    if (url.host === "api.twilio.com") return new Response(JSON.stringify({ sid: "SM_fake" }), { status: 201 });
    if (url.host === "verify.twilio.com") {
      // Verify approves "246810" only: the code it would have sent before the switch.
      if (url.pathname.endsWith("/Verifications")) return new Response("{}", { status: 201 });
      return body.get("Code") === "246810"
        ? new Response(JSON.stringify({ status: "approved", valid: true }), { status: 200 })
        : new Response("{}", { status: 404 });
    }
    throw new Error(`network access attempted: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function held(t: TestConvex): Promise<Id<"users">> {
  const id = await createUser(t, "kayla@home.example");
  await t.run((ctx) => ctx.db.patch(id, { phone: PHONE, phoneVerificationTime: 1 }));
  return id;
}

/** The code in the last text Context sent. */
function textedCode(): string {
  const sent = calls.filter((call) => call.host === "api.twilio.com").at(-1);
  const code = /^(\d{6}) is your Context code/.exec(sent?.body.get("Body") ?? "")?.[1];
  if (code === undefined) throw new Error("no code was texted");
  return code;
}

async function signIn(t: TestConvex, code: string) {
  const result = await t.action(api.auth.signIn, { provider: "phone-verify", params: { phone: PHONE, code } });
  await drainScheduled(t);
  return result.tokens !== null;
}

const start = (t: TestConvex) => t.action(api.functions.phoneSignIn.start, { phone: PHONE });

describe("the text", () => {
  test("says Context, comes through the Messaging Service, and never asks Verify", async () => {
    const t = setupTest();
    await held(t);
    expect(await start(t)).toEqual({ status: "sent", phone: PHONE });
    const sent = calls.find((call) => call.host === "api.twilio.com")!;
    expect(sent.path).toBe("/2010-04-01/Accounts/AC_test_not_real/Messages.json");
    expect(sent.body.get("To")).toBe(PHONE);
    expect(sent.body.get("MessagingServiceSid")).toBe("MG_test_not_real");
    // No `@host #code` line: iOS offers a domain-bound code only to that
    // site or an app associated with it, and the app has no associated
    // domains, so the line kept the code out of autofill (Dev2, 2026-10-10).
    expect(sent.body.get("Body")).toMatch(/^\d{6} is your Context code\. It expires in 10 minutes\.$/);
    expect(sent.body.get("Body")).not.toMatch(/togather/i);
    expect(calls.some((call) => call.host === "verify.twilio.com")).toBe(false);
  });

  test("the code is never stored, only its hash", async () => {
    const t = setupTest();
    await held(t);
    await start(t);
    const code = textedCode();
    const rows = await t.run((ctx) => ctx.db.query("phoneCodes").collect());
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  test("codes are six digits, and the text is the code and nothing iOS would bind to a domain", () => {
    for (let i = 0; i < 200; i++) expect(newCode()).toMatch(/^\d{6}$/);
    expect(codeText("123456")).toBe("123456 is your Context code. It expires in 10 minutes.");
    expect(codeText("123456")).not.toMatch(/[@#]/);
  });
});

describe("checking it", () => {
  test("the texted code signs in once, and only to the phone's account", async () => {
    const t = setupTest();
    const id = await held(t);
    await start(t);
    const code = textedCode();
    expect(await signIn(t, code)).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.db.query("authSessions").collect()).map((row) => row.userId))).toEqual([id]);
    // Spent: the same code again is refused.
    expect(await signIn(t, code)).toBe(false);
  });

  test("a new code replaces the last one", async () => {
    const t = setupTest();
    await held(t);
    await start(t);
    const first = textedCode();
    await start(t);
    const second = textedCode();
    if (first !== second) expect(await signIn(t, first)).toBe(false);
    expect(await signIn(t, second)).toBe(true);
  });

  test("five wrong codes, then even the right one is refused", async () => {
    const t = setupTest();
    await held(t);
    await start(t);
    const code = textedCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect(await signIn(t, wrong)).toBe(false);
    expect(await signIn(t, code)).toBe(false);
  });

  test("a code older than ten minutes is refused", async () => {
    const t = setupTest();
    await held(t);
    await start(t);
    const code = textedCode();
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("phoneCodes").first())!;
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    expect(await signIn(t, code)).toBe(false);
  });

  test("a code Verify sent before the switch still checks through Verify", async () => {
    const t = setupTest();
    await held(t);
    expect(await signIn(t, "246810")).toBe(true);
    expect(calls.some((call) => call.host === "verify.twilio.com" && call.path.endsWith("/VerificationCheck"))).toBe(true);
  });

  test("the phone check sends and confirms Context's own code too", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    const me = asUser(t, userId);
    expect(await me.action(api.functions.phoneCheck.sendPhoneCode, { phone: PHONE })).toEqual({ status: "sent", phone: PHONE });
    expect(await me.action(api.functions.phoneCheck.confirmPhoneCode, { phone: PHONE, code: textedCode() })).toEqual({
      status: "confirmed",
    });
    expect(calls.some((call) => call.host === "verify.twilio.com")).toBe(false);
  });
});

describe("the sender staff set in the admin console (Dev2, 2026-10-09)", () => {
  const STAFF = "staff@context.test";
  const STORED = "MG0123456789abcdef0123456789abcdef";

  async function staff(t: TestConvex) {
    vi.stubEnv("ADMIN_EMAILS", STAFF);
    const id = await t.run((ctx) => ctx.db.insert("users", { email: STAFF, emailVerificationTime: Date.now() } as never));
    return t.withIdentity({ subject: id });
  }

  test("texts in Context's words through the stored Messaging Service when the deployment names none", async () => {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "");
    const t = setupTest();
    await held(t);
    const admin = await staff(t);
    expect(await admin.query(api.functions.admin.signInTexts, {})).toEqual({
      messagingServiceSid: null,
      fromDeployment: false,
      saysContext: false,
    });
    await admin.mutation(api.functions.admin.setSignInTextsSender, { messagingServiceSid: ` ${STORED} ` });
    expect(await admin.query(api.functions.admin.signInTexts, {})).toEqual({
      messagingServiceSid: STORED,
      fromDeployment: false,
      saysContext: true,
    });
    await start(t);
    const sent = calls.find((call) => call.host === "api.twilio.com")!;
    expect(sent.body.get("MessagingServiceSid")).toBe(STORED);
    expect(calls.some((call) => call.host === "verify.twilio.com")).toBe(false);
    expect(await signIn(t, textedCode())).toBe(true);
  });

  test("clearing it puts codes back through Verify", async () => {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "");
    const t = setupTest();
    await held(t);
    const admin = await staff(t);
    await admin.mutation(api.functions.admin.setSignInTextsSender, { messagingServiceSid: STORED });
    await admin.mutation(api.functions.admin.setSignInTextsSender, { messagingServiceSid: "" });
    await start(t);
    expect(calls.some((call) => call.host === "api.twilio.com")).toBe(false);
    expect(calls.some((call) => call.host === "verify.twilio.com")).toBe(true);
  });

  test("the deployment's own value wins over the stored one", async () => {
    const t = setupTest();
    await held(t);
    const admin = await staff(t);
    await admin.mutation(api.functions.admin.setSignInTextsSender, { messagingServiceSid: STORED });
    expect((await admin.query(api.functions.admin.signInTexts, {})).fromDeployment).toBe(true);
    await start(t);
    expect(calls.find((call) => call.host === "api.twilio.com")!.body.get("MessagingServiceSid")).toBe("MG_test_not_real");
  });

  test("only a Messaging Service ID is kept, and only staff may set or read it", async () => {
    const t = setupTest();
    const admin = await staff(t);
    for (const bad of ["MG123", "AC" + "0".repeat(32), "+12025550100", "https://x.test"]) {
      await expect(admin.mutation(api.functions.admin.setSignInTextsSender, { messagingServiceSid: bad })).rejects.toThrow(
        /Messaging Service/,
      );
    }
    const stranger = await createUser(t, "someone@home.example");
    await expect(
      asUser(t, stranger).mutation(api.functions.admin.setSignInTextsSender, { messagingServiceSid: STORED }),
    ).rejects.toThrow();
    await expect(asUser(t, stranger).query(api.functions.admin.signInTexts, {})).rejects.toThrow();
    await expect(t.mutation(api.functions.admin.setSignInTextsSender, { messagingServiceSid: STORED })).rejects.toThrow();
  });
});

describe("the stored sender on the real runtime", () => {
  test("reads the account keys by name, because a deployment's environment cannot be listed", () => {
    // Convex's `process.env` answers a named read but lists no keys, so
    // `{ ...process.env }` is empty there. That shipped (#1439): the panel
    // saved the ID and every code still went through Verify.
    const values: Record<string, string> = {
      TWILIO_ACCOUNT_SID: "AC_test_not_real",
      TWILIO_API_KEY_SID: "SK_test_not_real",
      TWILIO_API_KEY_SECRET: "test-secret-not-real",
    };
    const unlistable = new Proxy({} as Record<string, string | undefined>, {
      get: (_target, name) => values[name as string],
      ownKeys: () => [],
    });
    expect({ ...unlistable }).toEqual({});
    expect(smsKeysWithSender("MG0123456789abcdef0123456789abcdef", unlistable)).toEqual({
      accountSid: "AC_test_not_real",
      apiKeySid: "SK_test_not_real",
      authToken: "test-secret-not-real",
      from: { messagingServiceSid: "MG0123456789abcdef0123456789abcdef" },
    });
  });
});
