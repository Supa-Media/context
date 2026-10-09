import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, captureError, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";
import { isExemptEmail, normalizePhone, phoneCheckRequired } from "../functions/lib/phoneCheck";
import { REVIEWER_EMAIL } from "../functions/lib/reviewerAccount";
import { TEST_ACCOUNT_EMAIL } from "../functions/lib/testAccount";

/**
 * THE PHONE CHECK.
 *
 * Every account confirms a phone once before the app opens. What must hold:
 * it is off unless both the switch and the keys are set (a screen whose code
 * cannot arrive would lock everybody out), only Twilio's "approved" confirms a
 * phone, one phone belongs to one account, and texting is rate limited per
 * person and per number. Twilio is a fake `fetch` here; the numbers are
 * reserved fiction.
 */

const PHONE = "+15555550100";
const KEYS = {
  TWILIO_ACCOUNT_SID: "AC_test_not_real",
  TWILIO_AUTH_TOKEN: "test-token-not-real",
  TWILIO_VERIFY_SERVICE_SID: "VA_test_not_real",
};

type TwilioCall = { path: string; body: URLSearchParams };
let calls: TwilioCall[];
/** The code the fake Twilio approves; anything else is a 404, as Twilio answers. */
let goodCode: string;

beforeEach(() => {
  calls = [];
  goodCode = "123456";
  for (const [name, value] of Object.entries(KEYS)) vi.stubEnv(name, value);
  vi.stubEnv("PHONE_CHECK", "required");
  vi.stubGlobal("fetch", async (url: string, init: { body: URLSearchParams }) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: new URLSearchParams(init.body) });
    if (path.endsWith("/Verifications")) return new Response(JSON.stringify({ status: "pending" }), { status: 201 });
    if (new URLSearchParams(init.body).get("Code") !== goodCode) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ status: "approved", valid: true }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function check(t: TestConvex, userId: Id<"users">) {
  return await asUser(t, userId).query(api.functions.phoneCheck.myPhoneCheck, {});
}
async function send(t: TestConvex, userId: Id<"users">, phone = PHONE) {
  return await asUser(t, userId).action(api.functions.phoneCheck.sendPhoneCode, { phone });
}
async function confirm(t: TestConvex, userId: Id<"users">, code = goodCode, phone = PHONE) {
  return await asUser(t, userId).action(api.functions.phoneCheck.confirmPhoneCode, { phone, code });
}

describe("when it asks", () => {
  test("a new account is asked, and is not once its phone is confirmed", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    expect(await check(t, userId)).toMatchObject({ required: true, confirmed: false });
    expect(await send(t, userId)).toEqual({ status: "sent", phone: PHONE });
    // No CustomFriendlyName: Twilio refused every send carrying one (2026-10-09).
    expect(calls[0]?.body.has("CustomFriendlyName")).toBe(false);
    expect(await confirm(t, userId)).toEqual({ status: "confirmed" });
    expect(await check(t, userId)).toMatchObject({ required: false, confirmed: true });
    const user = await t.run(async (ctx) => await ctx.db.get(userId));
    expect(user?.phone).toBe(PHONE);
    expect(typeof user?.phoneVerificationTime).toBe("number");
  });

  test("off without the switch, and off with the switch but no keys", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    vi.stubEnv("PHONE_CHECK", "");
    expect((await check(t, userId)).required).toBe(false);
    vi.stubEnv("PHONE_CHECK", "required");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    expect(phoneCheckRequired()).toBe(false);
    expect((await check(t, userId)).required).toBe(false);
    expect(await send(t, userId)).toEqual({ status: "failed" });
    expect(calls).toHaveLength(0);
  });

  test("a Twilio API key works in place of the auth token", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_API_KEY_SID", "SK_test_not_real");
    vi.stubEnv("TWILIO_API_KEY_SECRET", "test-secret-not-real");
    expect(phoneCheckRequired()).toBe(true);
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    expect(await send(t, userId)).toEqual({ status: "sent", phone: PHONE });
  });

  test("a phone linked for texting already counts", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    await t.run(async (ctx) => {
      await ctx.db.insert("phoneLinks", { userId, phone: PHONE, linkedAt: Date.now() });
    });
    expect(await check(t, userId)).toMatchObject({ required: false, confirmed: true });
  });

  test("the reviewer, the test account and listed addresses are never asked", async () => {
    vi.stubEnv("PHONE_CHECK_EXEMPT_EMAILS", "qa@example.invalid, inbox@example.invalid");
    expect(isExemptEmail(REVIEWER_EMAIL)).toBe(true);
    expect(isExemptEmail(TEST_ACCOUNT_EMAIL)).toBe(true);
    expect(isExemptEmail("QA@example.invalid")).toBe(true);
    expect(isExemptEmail("inbox+run-42@example.invalid")).toBe(true);
    expect(isExemptEmail("someone@example.invalid")).toBe(false);
    expect(isExemptEmail("qa@example.invalid.attacker.test")).toBe(false);
    // Staging personas only on the isolated staging deployment, which a test is not.
    expect(isExemptEmail("alpha@supa.media")).toBe(false);
    const t = setupTest();
    const userId = await createUser(t, "qa@example.invalid");
    expect((await check(t, userId)).required).toBe(false);
  });

  test("signed out is never asked, and cannot send or confirm", async () => {
    const t = setupTest();
    expect(await t.query(api.functions.phoneCheck.myPhoneCheck, {})).toEqual({ required: false, confirmed: false, needsEmail: false });
    expect(errorCode(await captureError(() => t.action(api.functions.phoneCheck.sendPhoneCode, { phone: PHONE })))).toBe(
      "NOT_AUTHENTICATED",
    );
    expect(
      errorCode(await captureError(() => t.action(api.functions.phoneCheck.confirmPhoneCode, { phone: PHONE, code: "1" }))),
    ).toBe("NOT_AUTHENTICATED");
  });
});

describe("confirming", () => {
  test("a wrong code confirms nothing", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    await send(t, userId);
    expect(await confirm(t, userId, "999999")).toEqual({ status: "wrong" });
    expect((await check(t, userId)).confirmed).toBe(false);
  });

  test("an approved code for a different number than was typed is checked against the typed number", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    await send(t, userId);
    await confirm(t, userId, goodCode, "+1 (555) 555-0199");
    expect(calls.at(-1)?.body.get("To")).toBe("+15555550199");
    const user = await t.run(async (ctx) => await ctx.db.get(userId));
    expect(user?.phone).toBe("+15555550199");
  });

  test("Twilio answering 200 without approval is not a confirmation", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "pending", valid: false }), { status: 200 }));
    expect(await confirm(t, userId)).toEqual({ status: "wrong" });
    expect((await check(t, userId)).confirmed).toBe(false);
  });

  test("a malformed code never reaches Twilio", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    expect(await confirm(t, userId, "12ab")).toEqual({ status: "wrong" });
    expect(calls).toHaveLength(0);
  });

  test("typed codes are limited per person", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    for (let i = 0; i < 10; i++) expect((await confirm(t, userId, "000000")).status).toBe("wrong");
    expect(await confirm(t, userId)).toEqual({ status: "too_many" });
    expect((await check(t, userId)).confirmed).toBe(false);
  });
});

/** Two accounts that each own a workspace: these are never joined. */
async function twoOwners(t: TestConvex) {
  const ada = await createUser(t, "ada@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");
  await createWorkspace(t, ada, "ada-notes");
  await createWorkspace(t, bob, "bob-notes");
  return { ada, bob };
}

describe("one phone, one account", () => {
  test("a phone another owning account confirmed is refused at send", async () => {
    const t = setupTest();
    const { ada, bob } = await twoOwners(t);
    await send(t, ada);
    await confirm(t, ada);
    const before = calls.length;
    expect(await send(t, bob)).toEqual({ status: "taken" });
    expect(calls.length).toBe(before);
  });

  test("a phone another owning account linked for texting is refused too", async () => {
    const t = setupTest();
    const { ada, bob } = await twoOwners(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("phoneLinks", { userId: ada, phone: PHONE, linkedAt: Date.now() });
    });
    expect(await send(t, bob)).toEqual({ status: "taken" });
  });

  test("two owning accounts racing for one number: the second confirmation is refused", async () => {
    const t = setupTest();
    const { ada, bob } = await twoOwners(t);
    expect((await send(t, ada)).status).toBe("sent");
    expect((await send(t, bob)).status).toBe("sent");
    expect(await confirm(t, ada)).toEqual({ status: "confirmed" });
    expect(await confirm(t, bob)).toEqual({ status: "taken" });
    expect((await check(t, bob)).confirmed).toBe(false);
  });

  test("an unconfirmed number on another account does not block anybody", async () => {
    const t = setupTest();
    const { ada, bob } = await twoOwners(t);
    await t.run(async (ctx) => await ctx.db.patch(ada, { phone: PHONE }));
    expect((await send(t, bob)).status).toBe("sent");
  });
});

describe("one person, one account: a held number joins the two", () => {
  test("a new email account typing a number an account holds closes into it, email and all", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    await createWorkspace(t, ada, "ada-notes");
    await send(t, ada);
    await confirm(t, ada);
    const fresh = await createUser(t, "ada@work.example.invalid");
    expect(await send(t, fresh)).toEqual({ status: "sent", phone: PHONE });
    expect(await confirm(t, fresh)).toEqual({ status: "joined" });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(fresh)).toBeNull();
      const emails = await ctx.db
        .query("signInEmails")
        .withIndex("by_user", (q) => q.eq("userId", ada))
        .collect();
      expect(emails.map((row) => row.email)).toEqual(["ada@work.example.invalid"]);
    });
  });

  test("a wrong code joins nothing", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    await send(t, ada);
    await confirm(t, ada);
    const fresh = await createUser(t, "ada@work.example.invalid");
    await send(t, fresh);
    expect(await confirm(t, fresh, "000000")).toEqual({ status: "wrong" });
    expect(await t.run(async (ctx) => await ctx.db.get(fresh))).not.toBeNull();
  });

  test("an email account that owns a workspace takes the phone from an empty phone account", async () => {
    const t = setupTest();
    const old = await createUser(t, "ada@example.invalid");
    await createWorkspace(t, old, "ada-notes");
    const byPhone = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        phone: PHONE,
        phoneVerificationTime: Date.now(),
        createdAt: Date.now(),
      });
      await ctx.db.insert("phoneLinks", { userId: id, phone: PHONE, linkedAt: Date.now() });
      return id;
    });
    expect((await send(t, old)).status).toBe("sent");
    expect(await confirm(t, old)).toEqual({ status: "confirmed" });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(byPhone)).toBeNull();
      expect((await ctx.db.get(old))?.phone).toBe(PHONE);
      const link = await ctx.db
        .query("phoneLinks")
        .withIndex("by_phone", (q) => q.eq("phone", PHONE))
        .first();
      expect(link?.userId).toBe(old);
    });
    expect((await check(t, old)).confirmed).toBe(true);
  });
});

describe("texting a code", () => {
  test("a number without a country code is refused before Twilio", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    expect(await send(t, userId, "555 555 0100")).toEqual({ status: "invalid_phone" });
    expect(calls).toHaveLength(0);
  });

  test("sends are limited per person", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    for (let i = 0; i < 5; i++) {
      expect((await send(t, userId, `+1555555010${i}`)).status).toBe("sent");
    }
    expect(await send(t, userId, "+15555550109")).toEqual({ status: "too_many" });
    expect(calls).toHaveLength(5);
  });

  test("sends are limited per number, across accounts, without spending the next person's", async () => {
    const t = setupTest();
    const people = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createUser(t, `p${i}@example.invalid`)),
    );
    for (let i = 0; i < 5; i++) expect((await send(t, people[i]!)).status).toBe("sent");
    expect(await send(t, people[5]!)).toEqual({ status: "too_many" });
    // The refused send did not spend person 5's own budget.
    for (let i = 0; i < 5; i++) {
      expect((await send(t, people[5]!, `+1555555020${i}`)).status).toBe("sent");
    }
  });

  test("an account that already confirmed is not texted again", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.invalid");
    await send(t, userId);
    await confirm(t, userId);
    expect(await send(t, userId, "+15555550111")).toEqual({ status: "not_needed" });
  });
});

describe("normalizePhone", () => {
  test.each([
    ["+1 (555) 555-0100", "+15555550100"],
    ["+44 20 7946 0958", "+442079460958"],
    ["0044 20 7946 0958", "+442079460958"],
    ["+1.555.555.0100", "+15555550100"],
  ])("%s → %s", (raw, phone) => expect(normalizePhone(raw)).toBe(phone));

  test.each(["5555550100", "+0123456789", "+1", "+1555abc0100", ""])("refuses %s", (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});
