import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { LINQ_ZERO_SERVICE } from "../functions/lib/adminFns/texAllowlist";
import { OPEN_SIGNUP_ENV_VAR } from "../functions/lib/waitlist";
import { LINQ_PARTNER_API, TEX_GREETING } from "../functions/texGreeting";
import { admittedText } from "../functions/waitlistText";
import { createUser, createWorkspace, drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * LET IN MEANS TEX TEXTS FIRST.
 *
 * Dev2, 2026-10-17: "when someone signs up for the waitlist, and I let them
 * in, I want them to get immediate tex access so that tex can guide them".
 * What must hold: Let in on a phone Tex can set up opens a chat from Tex's
 * line with the handle question, instead of the "You're in" SMS; the reply is
 * read as the handle, so setup carries on from it; each row is greeted once;
 * a failed greeting leaves no standing question (so "hi" is never taken as a
 * handle) and falls back to the SMS; a phone setup would refuse is never
 * greeted; and somebody let in by address is greeted when they confirm a
 * phone. Linq and Twilio are a fake `fetch`; the numbers are reserved fiction.
 */

const STAFF = "staff@context.invalid";
const ORIGIN = "https://context.test";
const PHONE = "+15555550142";
const TEX = "+15555550199";
const ORG = "org_fixture";

type Call = { url: string; body: string; auth: string | null };
let calls: Call[];
let chatStatus: number;

beforeEach(() => {
  calls = [];
  chatStatus = 201;
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
  vi.stubEnv("LINQ_API_KEY", "fixture-linq-key-not-real");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ url, body: String(init.body ?? ""), auth });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.startsWith("https://api.twilio.com/")) return json({ sid: "SM_fake" }, 201);
    if (url === `${LINQ_ZERO_SERVICE}/cli/account-info`) {
      return json({ orgId: ORG, accountInfo: { accountLabel: "Shared", phones: [{ phoneNumber: TEX }] } });
    }
    if (url === `${LINQ_ZERO_SERVICE}/cli/contacts?orgId=${ORG}`) return json({ contacts: [] });
    if (url === `${LINQ_ZERO_SERVICE}/cli/contacts/add`) return json({});
    if (url === `${LINQ_PARTNER_API}/chats`) return json({ chat: { id: "chat_fixture" } }, chatStatus);
    throw new Error(`network access attempted: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function staff(t: TestConvex) {
  const id = await t.run((ctx) => ctx.db.insert("users", { email: STAFF, emailVerificationTime: 1 } as never));
  return t.withIdentity({ subject: id });
}

async function row(t: TestConvex, fields: { phone: string } | { email: string }): Promise<Id<"waitlist">> {
  return await t.run((ctx) => ctx.db.insert("waitlist", { ...fields, status: "waiting", joinedAt: 1, source: "login" }));
}

const chats = () => calls.filter((call) => call.url === `${LINQ_PARTNER_API}/chats`);
const sms = () => calls.filter((call) => call.url.startsWith("https://api.twilio.com/"));
const smsBody = (call: Call) => new URLSearchParams(call.body).get("Body");
const asked = (t: TestConvex) =>
  t.run(async (ctx) => (await ctx.db.query("textSetups").collect()).filter((r) => r.stage === "asked"));

describe("Let in on a phone row", () => {
  test("Tex opens the chat from its line with the handle question, and no SMS goes", async () => {
    const t = setupTest();
    const as = await staff(t);
    const id = await row(t, { phone: PHONE });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(chats()).toHaveLength(1);
    const sent = JSON.parse(chats()[0]!.body);
    expect(sent).toEqual({
      from: TEX,
      to: [PHONE],
      message: { parts: [{ type: "text", value: TEX_GREETING }], idempotency_key: `tex-greeting:${id}` },
    });
    expect(chats()[0]!.auth).toBe("Bearer fixture-linq-key-not-real");
    expect(sms()).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(id)))?.texGreetedAt).toBeTypeOf("number");
    expect((await asked(t)).map((r) => r.phone)).toEqual([PHONE]);
  });

  test("the reply is read as the handle, so setup carries on from it", async () => {
    const t = setupTest();
    const as = await staff(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [await row(t, { phone: PHONE })] });
    await drainScheduled(t);
    const answer = await t.mutation(internal.functions.textSetup.answerSetupText, { phone: PHONE, candidate: "ada" });
    expect(answer).toMatchObject({ status: "set_up", handle: "ada" });
  });

  test("letting the same row in again, or twice at once, greets once", async () => {
    const t = setupTest();
    const as = await staff(t);
    const id = await row(t, { phone: PHONE });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id, id] });
    await drainScheduled(t);
    await as.mutation(api.functions.admin.removeFromWaitlist, { ids: [id] });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(chats()).toHaveLength(1);
  });

  test("Linq refusing the chat leaves no standing question and falls back to the SMS", async () => {
    chatStatus = 403;
    const t = setupTest();
    const as = await staff(t);
    const id = await row(t, { phone: PHONE });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(chats()).toHaveLength(1);
    expect(sms().map(smsBody)).toEqual([admittedText(`${ORIGIN}/login`, TEX)]);
    expect((await t.run((ctx) => ctx.db.get(id)))?.texGreetedAt).toBeUndefined();
    expect(await asked(t)).toEqual([]);
    // Their first text, whatever it says, is asked for a handle, never taken as one.
    expect(await t.mutation(internal.functions.textSetup.answerSetupText, { phone: PHONE, candidate: "hi" })).toEqual({
      status: "ask",
    });
  });

  test("a phone whose account already has a personal workspace is never greeted", async () => {
    const t = setupTest();
    const as = await staff(t);
    const holder = await createUser(t, "ada@studio.test");
    await t.run((ctx) => ctx.db.patch(holder, { phone: PHONE, phoneVerificationTime: Date.now() }));
    await createWorkspace(t, holder, "ada-notes", { kind: "personal" });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [await row(t, { phone: PHONE })] });
    await drainScheduled(t);
    expect(chats()).toHaveLength(0);
    expect(sms().map(smsBody)).toEqual([admittedText(`${ORIGIN}/login`, TEX)]);
  });

  test("with no Linq key there is no greeting and the plain SMS goes", async () => {
    vi.stubEnv("LINQ_API_KEY", "");
    const t = setupTest();
    const as = await staff(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [await row(t, { phone: PHONE })] });
    await drainScheduled(t);
    expect(chats()).toHaveLength(0);
    expect(sms().map(smsBody)).toEqual([admittedText(`${ORIGIN}/login`)]);
  });
});

describe("Let in on an address", () => {
  test("Tex greets the phone the person confirms in the app", async () => {
    const t = setupTest();
    const as = await staff(t);
    const id = await row(t, { email: "jon@studio.test" });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(chats()).toHaveLength(0);
    const jon = await t.run((ctx) => ctx.db.insert("users", { email: "jon@studio.test", emailVerificationTime: 1 } as never));
    await t.mutation(internal.functions.phoneCheck.recordConfirmedPhone, { userId: jon, phone: PHONE });
    await drainScheduled(t);
    expect(chats().map((call) => JSON.parse(call.body).to)).toEqual([[PHONE]]);
  });

  test("somebody never let in is not greeted when they confirm a phone", async () => {
    const t = setupTest();
    await row(t, { email: "jon@studio.test" });
    const jon = await t.run((ctx) => ctx.db.insert("users", { email: "jon@studio.test", emailVerificationTime: 1 } as never));
    await t.mutation(internal.functions.phoneCheck.recordConfirmedPhone, { userId: jon, phone: PHONE });
    await drainScheduled(t);
    expect(chats()).toHaveLength(0);
  });
});
