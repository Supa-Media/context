import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { OPEN_SIGNUP_ENV_VAR } from "../functions/lib/waitlist";
import { admittedText } from "../functions/waitlistText";
import { drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * THE "YOU'RE IN" TEXT.
 *
 * Somebody who joined the waitlist with a phone has no address to mail, so
 * until 2026-10-12 nobody told them when staff let them in (Dev2: "How do
 * they know that they've gotten off the waitlist?"). What must hold: Let in
 * texts a phone row once, through the Messaging Service, with the sign-in
 * link; joining the list texts nothing (the SMS-pump guard); an email row is
 * never texted; and with no Messaging Service nothing is sent. Twilio is a
 * fake `fetch`; the numbers are reserved fiction.
 */

const STAFF = "staff@context.invalid";
const ORIGIN = "https://context.test";
const PHONE = "+15555550142";

type Call = { host: string; body: URLSearchParams };
let calls: Call[];

beforeEach(async () => {
  calls = [];
  vi.stubEnv(ADMIN_EMAILS_ENV_VAR, STAFF);
  vi.stubEnv(OPEN_SIGNUP_ENV_VAR, "");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_not_real");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token-not-real");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA_test_not_real");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG_test_not_real");
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  vi.stubEnv("SITE_URL", ORIGIN);
  vi.stubEnv("CONVEX_SITE_URL", ORIGIN);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push({ host: url.host, body: new URLSearchParams(init?.body as URLSearchParams) });
    if (url.host === "api.twilio.com") return new Response(JSON.stringify({ sid: "SM_fake" }), { status: 201 });
    if (url.host === "verify.twilio.com") return new Response("{}", { status: 201 });
    throw new Error(`network access attempted: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function staff(t: TestConvex) {
  const id = await t.run(async (ctx) =>
    ctx.db.insert("users", { email: STAFF, emailVerificationTime: Date.now() } as never),
  );
  return t.withIdentity({ subject: id });
}

async function phoneRow(t: TestConvex, phone = PHONE): Promise<Id<"waitlist">> {
  return await t.run((ctx) =>
    ctx.db.insert("waitlist", { phone, status: "waiting", joinedAt: Date.now(), source: "login" }),
  );
}

const texts = () => calls.filter((call) => call.host === "api.twilio.com");

describe("Let in on a phone row", () => {
  test("texts it once, through the Messaging Service, with the sign-in link", async () => {
    const t = setupTest();
    const as = await staff(t);
    const id = await phoneRow(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id, id] });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(texts()).toHaveLength(1);
    const sent = texts()[0]!.body;
    expect(sent.get("To")).toBe(PHONE);
    expect(sent.get("MessagingServiceSid")).toBe("MG_test_not_real");
    expect(sent.get("Body")).toBe(admittedText(`${ORIGIN}/login`));
    expect(sent.get("Body")).toMatch(/^You're in!/);
    expect(calls.some((call) => call.host === "verify.twilio.com")).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.admittedTextAt).toBeTypeOf("number");
    expect(row?.admittedMailAt).toBeUndefined();
  });

  test("a phone pasted into Add is texted once, and pasting it again texts nothing", async () => {
    const t = setupTest();
    const as = await staff(t);
    await as.mutation(api.functions.admin.addToWaitlist, { emails: "+1 (555) 555-0142" });
    await as.mutation(api.functions.admin.addToWaitlist, { emails: "+1 (555) 555-0142" });
    await drainScheduled(t);
    expect(texts().map((call) => call.body.get("To"))).toEqual([PHONE]);
  });

  test("removed again before the text goes out, it is not sent", async () => {
    const t = setupTest();
    const as = await staff(t);
    const id = await phoneRow(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await as.mutation(api.functions.admin.removeFromWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(texts()).toHaveLength(0);
  });

  test("with no Messaging Service nothing is sent, and Verify is never asked", async () => {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "");
    const t = setupTest();
    const as = await staff(t);
    const id = await phoneRow(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(calls).toHaveLength(0);
  });
});

describe("nobody else is texted", () => {
  test("joining the list by phone texts nothing", async () => {
    const t = setupTest();
    expect((await t.action(api.functions.phoneSignIn.start, { phone: PHONE })).status).not.toBe("sent");
    await drainScheduled(t);
    expect(calls).toHaveLength(0);
    const row = await t.run((ctx) => ctx.db.query("waitlist").withIndex("by_phone", (q) => q.eq("phone", PHONE)).first());
    expect(row?.status).toBe("waiting");
  });

  test("an email row is mailed, never texted", async () => {
    const t = setupTest();
    const as = await staff(t);
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    const id = (await t.run((ctx) => ctx.db.query("waitlist").first()))!._id;
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(texts()).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(id)))?.admittedMailAt).toBeTypeOf("number");
  });
});

describe("people let in by phone before Let in texted anyone", () => {
  async function untold(t: TestConvex, phone: string): Promise<Id<"waitlist">> {
    // How #1557 found them: let in, `admittedMailAt` claimed, nothing sent.
    return await t.run((ctx) =>
      ctx.db.insert("waitlist", {
        phone,
        status: "admitted",
        joinedAt: 1,
        admittedAt: 2,
        admittedMailAt: 2,
        source: "login",
      }),
    );
  }

  test("are counted and texted once; anyone already signed in or already texted is left alone", async () => {
    const t = setupTest();
    const as = await staff(t);
    await untold(t, "+15555550101");
    await untold(t, "+15555550102");
    // Signed in already: they found out.
    await untold(t, "+15555550103");
    await t.run((ctx) => ctx.db.insert("users", { phone: "+15555550103", phoneVerificationTime: 1 } as never));
    // Let in since #1557: already texted.
    const recent = await phoneRow(t, "+15555550104");
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [recent] });
    // Still waiting, and an email row: neither is "let in and untold".
    await phoneRow(t, "+15555550105");
    await t.run((ctx) =>
      ctx.db.insert("waitlist", { email: "jon@studio.test", status: "admitted", joinedAt: 1, source: "homepage" }),
    );
    await drainScheduled(t);
    calls = [];

    expect(await as.query(api.functions.admin.untoldPhoneWaitlist, {})).toBe(2);
    expect(await as.mutation(api.functions.admin.textUntoldPhoneWaitlist, {})).toEqual({ texted: 2, left: 0 });
    await drainScheduled(t);
    expect(texts().map((call) => call.body.get("To")).sort()).toEqual(["+15555550101", "+15555550102"]);
    expect(await as.query(api.functions.admin.untoldPhoneWaitlist, {})).toBe(0);
    expect(await as.mutation(api.functions.admin.textUntoldPhoneWaitlist, {})).toEqual({ texted: 0, left: 0 });
    await drainScheduled(t);
    expect(texts()).toHaveLength(2);
  });

  test("strangers can neither count nor text them", async () => {
    const t = setupTest();
    await untold(t, "+15555550101");
    const stranger = t.withIdentity({
      subject: await t.run((ctx) => ctx.db.insert("users", { email: "who@else.test" } as never)),
    });
    await expect(stranger.query(api.functions.admin.untoldPhoneWaitlist, {})).rejects.toThrow();
    await expect(stranger.mutation(api.functions.admin.textUntoldPhoneWaitlist, {})).rejects.toThrow();
    await expect(t.mutation(api.functions.admin.textUntoldPhoneWaitlist, {})).rejects.toThrow();
    await drainScheduled(t);
    expect(texts()).toHaveLength(0);
  });
});
