import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { LINQ_ZERO_SERVICE, SHARED_LINE_CAP } from "../functions/lib/adminFns/texAllowlist";
import { OPEN_SIGNUP_ENV_VAR } from "../functions/lib/waitlist";
import { admittedText } from "../functions/waitlistText";
import { asUser, createUser, drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * LETTING SOMEBODY IN PUTS THEM ON TEX'S LIST.
 *
 * Dev2, 2026-10-17: "letting someone off the wait list automatically puts
 * them into that list" — the Linq shared line's twenty contacts, the only
 * numbers whose texts reach Tex. What must hold: Let in adds the row's phone,
 * or the proven phone of the account its address belongs to, before the
 * "You're in" text names Tex; an address with no phone yet is added when that
 * person confirms one; a full list, a paid line or Linq failing never fails
 * the Let in and leaves a trail entry; and the text only names Tex once the
 * number is on the list. Linq and Twilio are a fake `fetch`; the numbers are
 * reserved fiction.
 */

const STAFF = "staff@context.invalid";
const ORIGIN = "https://context.test";
const PHONE = "+15555550142";
const TEX = "+15555550199";
const KEY = "fixture-linq-key-not-real";
const ORG = "org_fixture";

type Call = { url: string; body: string };
let calls: Call[];
let listed: string[];
let linq: { label: string; failAdd: number | null };

function phones(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `+1555010${String(i).padStart(4, "0")}`);
}

beforeEach(() => {
  calls = [];
  listed = [];
  linq = { label: "Shared", failAdd: null };
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
  vi.stubEnv("LINQ_API_KEY", KEY);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, body: String(init.body ?? "") });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith("/VerificationCheck")) return json({ status: "approved", valid: true });
    if (url.startsWith("https://api.twilio.com/")) return new Response(JSON.stringify({ sid: "SM_fake" }), { status: 201 });
    if (url === `${LINQ_ZERO_SERVICE}/cli/account-info`) {
      return json({ orgId: ORG, accountInfo: { accountLabel: linq.label, phones: [{ phoneNumber: TEX }] } });
    }
    if (url === `${LINQ_ZERO_SERVICE}/cli/contacts?orgId=${ORG}`) {
      return json({ contacts: listed.map((contactPhone) => ({ contactPhone })) });
    }
    if (url === `${LINQ_ZERO_SERVICE}/cli/contacts/add`) {
      if (linq.failAdd !== null) return new Response("linq-body", { status: linq.failAdd });
      listed.push(JSON.parse(String(init.body)).contactPhone);
      return json({});
    }
    if (url === `${LINQ_ZERO_SERVICE}/cli/contacts/remove`) {
      const gone = JSON.parse(String(init.body)).contactPhone;
      listed = listed.filter((phone) => phone !== gone);
      return json({});
    }
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

const adds = () => calls.filter((call) => call.url.endsWith("/cli/contacts/add"));
const texts = () => calls.filter((call) => call.url.startsWith("https://api.twilio.com/"));
const textBody = (call: Call) => new URLSearchParams(call.body).get("Body");
const trail = (t: TestConvex) =>
  t.run(async (ctx) =>
    (await ctx.db.query("adminAuditEvents").collect()).map((event) => [event.action, event.actorEmail, event.details]),
  );

describe("Let in on a phone row", () => {
  test("puts the phone on Tex's list before the text, and the text names Tex", async () => {
    const t = setupTest();
    const as = await staff(t);
    const id = await row(t, { phone: PHONE });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(listed).toEqual([PHONE]);
    expect(calls.indexOf(adds()[0]!)).toBeLessThan(calls.indexOf(texts()[0]!));
    expect(texts().map(textBody)).toEqual([admittedText(`${ORIGIN}/login`, TEX)]);
    expect(textBody(texts()[0]!)).toMatch(/^You're in! Text Tex at \+1 \(555\) 555-0199 and Tex/);
    // Texting Tex is the only thing it asks: no sign-in link beside it.
    expect(textBody(texts()[0]!)).not.toContain("/login");
    expect(await trail(t)).toEqual([
      ["tex.allowlist_added", STAFF, { phone: "0142", via: "waitlist", outcome: "added" }],
    ]);
    expect(JSON.stringify(await trail(t))).not.toContain(PHONE);
  });

  test("a full list never fails the Let in: the text leaves Tex out, and the trail says full", async () => {
    listed = phones(SHARED_LINE_CAP);
    const t = setupTest();
    const as = await staff(t);
    const id = await row(t, { phone: PHONE });
    expect(await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] })).toEqual({ changed: 1 });
    await drainScheduled(t);
    expect(adds()).toHaveLength(0);
    expect(texts().map(textBody)).toEqual([admittedText(`${ORIGIN}/login`)]);
    expect(await trail(t)).toEqual([
      ["tex.allowlist_refused", STAFF, { phone: "0142", via: "waitlist", outcome: "full" }],
    ]);
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("admitted");
  });

  test("Linq failing is on the trail, and the text still goes without Tex", async () => {
    linq.failAdd = 500;
    const t = setupTest();
    const as = await staff(t);
    const id = await row(t, { phone: PHONE });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(texts().map(textBody)).toEqual([admittedText(`${ORIGIN}/login`)]);
    expect(await trail(t)).toEqual([
      ["tex.allowlist_refused", STAFF, { phone: "0142", via: "waitlist", outcome: "error" }],
    ]);
  });

  test("a number already listed is not added again, and the text names Tex", async () => {
    listed = [PHONE];
    const t = setupTest();
    const as = await staff(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [await row(t, { phone: PHONE })] });
    await drainScheduled(t);
    expect(adds()).toHaveLength(0);
    expect(texts().map(textBody)).toEqual([admittedText(`${ORIGIN}/login`, TEX)]);
    expect(await trail(t)).toEqual([]);
  });

  test("a paid line has no list: nothing is added, and anybody may text it", async () => {
    linq.label = "Paid";
    const t = setupTest();
    const as = await staff(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [await row(t, { phone: PHONE })] });
    await drainScheduled(t);
    expect(adds()).toHaveLength(0);
    expect(texts().map(textBody)).toEqual([admittedText(`${ORIGIN}/login`, TEX)]);
    expect(await trail(t)).toEqual([]);
  });

  test("with no Linq key nothing reaches Linq, and the text is the plain one", async () => {
    vi.stubEnv("LINQ_API_KEY", "");
    const t = setupTest();
    const as = await staff(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [await row(t, { phone: PHONE })] });
    await drainScheduled(t);
    expect(calls.filter((call) => call.url.startsWith(LINQ_ZERO_SERVICE))).toHaveLength(0);
    expect(texts().map(textBody)).toEqual([admittedText(`${ORIGIN}/login`)]);
  });

  test("removed again before it runs, the phone is not added", async () => {
    const t = setupTest();
    const as = await staff(t);
    const id = await row(t, { phone: PHONE });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await as.mutation(api.functions.admin.removeFromWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(calls).toHaveLength(0);
  });

  test("let in again after a removal, an already-texted row is still added", async () => {
    const t = setupTest();
    const as = await staff(t);
    const id = await row(t, { phone: PHONE });
    await t.run((ctx) => ctx.db.patch(id, { admittedTextAt: 1 }));
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(listed).toEqual([PHONE]);
    expect(texts()).toHaveLength(0);
  });
});

describe("Let in on an address", () => {
  test("adds the proven phone of the account that address signs in to", async () => {
    const t = setupTest();
    const as = await staff(t);
    await t.run((ctx) =>
      ctx.db.insert("users", { email: "jon@studio.test", emailVerificationTime: 1, phone: PHONE, phoneVerificationTime: 1 } as never),
    );
    const id = await row(t, { email: "jon@studio.test" });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(listed).toEqual([PHONE]);
    // Tex cannot text first, so that phone is told where Tex is, once.
    expect(texts().map(textBody)).toEqual([admittedText(`${ORIGIN}/login`, TEX)]);
    expect(new URLSearchParams(texts()[0]!.body).get("To")).toBe(PHONE);
    await as.mutation(api.functions.admin.removeFromWaitlist, { ids: [id] });
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await drainScheduled(t);
    expect(texts()).toHaveLength(1);
  });

  test("an account that never proved the address, or a phone never proved, adds nothing", async () => {
    const t = setupTest();
    const as = await staff(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { email: "jon@studio.test", phone: PHONE, phoneVerificationTime: 1 } as never);
      await ctx.db.insert("users", { email: "amy@studio.test", emailVerificationTime: 1, phone: "+15555550143" } as never);
    });
    const ids = [await row(t, { email: "jon@studio.test" }), await row(t, { email: "amy@studio.test" })];
    await as.mutation(api.functions.admin.admitWaitlist, { ids });
    await drainScheduled(t);
    expect(calls).toHaveLength(0);
  });

  test("with no phone yet, the phone is added when the person confirms one", async () => {
    const t = setupTest();
    const as = await staff(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [await row(t, { email: "jon@studio.test" })] });
    await drainScheduled(t);
    expect(calls).toHaveLength(0);

    const jon = await t.run((ctx) =>
      ctx.db.insert("users", { email: "jon@studio.test", emailVerificationTime: 1 } as never),
    );
    expect(await t.mutation(internal.functions.phoneCheck.recordConfirmedPhone, { userId: jon, phone: PHONE })).toBe(
      "confirmed",
    );
    await drainScheduled(t);
    expect(listed).toEqual([PHONE]);
    expect(texts().map(textBody)).toEqual([admittedText(`${ORIGIN}/login`, TEX)]);
    // The person confirmed the phone, so the trail names them, not staff.
    expect(await trail(t)).toEqual([
      ["tex.allowlist_added", "jon@studio.test", { phone: "0142", via: "phone_confirmed", outcome: "added" }],
    ]);
  });

  test("changing the phone frees the old number's slot, so a person holds one", async () => {
    const t = setupTest();
    const as = await staff(t);
    const OLD = "+15555550143";
    const jon = await createUser(t, "jon@studio.test");
    await t.run((ctx) => ctx.db.patch(jon, { phone: OLD, phoneVerificationTime: Date.now() }));
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [await row(t, { email: "jon@studio.test" })] });
    await drainScheduled(t);
    expect(listed).toEqual([OLD]);

    expect(await asUser(t, jon).action(api.functions.phoneCheck.confirmPhoneCode, { phone: PHONE, code: "123456" })).toEqual({
      status: "confirmed",
    });
    await drainScheduled(t);
    expect(listed).toEqual([PHONE]);
    const actions = (await trail(t)).map(([action, actor]) => [action, actor]);
    expect(actions).toEqual([
      ["tex.allowlist_added", STAFF],
      ["tex.allowlist_removed", "jon@studio.test"],
      ["tex.allowlist_added", "jon@studio.test"],
    ]);
  });

  test("on a full list, a phone change still gets the new number on", async () => {
    const t = setupTest();
    const as = await staff(t);
    const OLD = "+15555550143";
    const jon = await createUser(t, "jon@studio.test");
    await t.run((ctx) => ctx.db.patch(jon, { phone: OLD, phoneVerificationTime: Date.now() }));
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [await row(t, { email: "jon@studio.test" })] });
    await drainScheduled(t);
    listed = [...listed, ...phones(SHARED_LINE_CAP - 1)];
    await asUser(t, jon).action(api.functions.phoneCheck.confirmPhoneCode, { phone: PHONE, code: "123456" });
    await drainScheduled(t);
    expect(listed).toContain(PHONE);
    expect(listed).not.toContain(OLD);
    expect(listed).toHaveLength(SHARED_LINE_CAP);
  });

  test("somebody never let in off the waitlist is not added when they confirm a phone", async () => {
    const t = setupTest();
    await row(t, { email: "jon@studio.test" });
    const jon = await t.run((ctx) =>
      ctx.db.insert("users", { email: "jon@studio.test", emailVerificationTime: 1 } as never),
    );
    await t.mutation(internal.functions.phoneCheck.recordConfirmedPhone, { userId: jon, phone: PHONE });
    await drainScheduled(t);
    expect(calls).toHaveLength(0);
  });
});
