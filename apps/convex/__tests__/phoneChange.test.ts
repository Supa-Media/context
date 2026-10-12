import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asPhoneOnly, asUser, captureError, createUser, errorCode, setupTest } from "./fixtures.helpers";

/**
 * CHANGING THE PHONE (board k4): email fixes the phone, never the other way
 * round. A device signed in with only the old phone cannot move the account
 * to a new one; a device that confirmed an emailed code can, the old number
 * stops signing in, and the texting assistant follows to the new number.
 */

const OLD = "+15555550100";
const NEW = "+15555550177";
const KEYS = {
  TWILIO_ACCOUNT_SID: "AC_test_not_real",
  TWILIO_AUTH_TOKEN: "test-token-not-real",
  TWILIO_VERIFY_SERVICE_SID: "VA_test_not_real",
};
const GOOD = "123456";
let texts: string[];

beforeEach(() => {
  texts = [];
  for (const [name, value] of Object.entries(KEYS)) vi.stubEnv(name, value);
  vi.stubGlobal("fetch", async (url: string, init: { body: URLSearchParams }) => {
    const path = new URL(url).pathname;
    const body = new URLSearchParams(init.body);
    if (path.endsWith("/Verifications")) {
      texts.push(body.get("To") ?? "");
      return new Response(JSON.stringify({ status: "pending" }), { status: 201 });
    }
    if (body.get("Code") !== GOOD) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ status: "approved", valid: true }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function adaWithPhone() {
  const t = setupTest();
  const ada = await createUser(t, "ada@home.example");
  await t.run(async (ctx) => {
    await ctx.db.patch(ada, { phone: OLD, phoneVerificationTime: Date.now() });
    await ctx.db.insert("phoneLinks", { userId: ada, phone: OLD, linkedAt: Date.now() });
  });
  return { t, ada };
}

describe("changing the phone", () => {
  test("a device with only the old phone is refused before any text is sent", async () => {
    const { t, ada } = await adaWithPhone();
    const { view } = await asPhoneOnly(t, ada);
    expect(errorCode(await captureError(() => view.action(api.functions.phoneCheck.sendPhoneCode, { phone: NEW })))).toBe(
      "EMAIL_PROOF_REQUIRED",
    );
    expect(texts).toEqual([]);
    expect(
      errorCode(await captureError(() => view.action(api.functions.phoneCheck.confirmPhoneCode, { phone: NEW, code: GOOD }))),
    ).toBe("EMAIL_PROOF_REQUIRED");
    expect((await t.run((ctx) => ctx.db.get(ada)))!.phone).toBe(OLD);
  });

  test("after an emailed code it moves, and texting moves with it", async () => {
    const { t, ada } = await adaWithPhone();
    expect(await asUser(t, ada).action(api.functions.phoneCheck.sendPhoneCode, { phone: NEW })).toEqual({ status: "sent", phone: NEW });
    expect(await asUser(t, ada).action(api.functions.phoneCheck.confirmPhoneCode, { phone: NEW, code: GOOD })).toEqual({
      status: "confirmed",
    });
    const user = await t.run((ctx) => ctx.db.get(ada));
    expect(user!.phone).toBe(NEW);
    const links = await t.run((ctx) => ctx.db.query("phoneLinks").collect());
    expect(links.map((l) => l.phone)).toEqual([NEW]);
  });

  test("never onto a number another account holds", async () => {
    const { t, ada } = await adaWithPhone();
    const bob = await createUser(t, "bob@home.example");
    await t.run((ctx) => ctx.db.patch(bob, { phone: NEW, phoneVerificationTime: Date.now() }));
    expect(await asUser(t, ada).action(api.functions.phoneCheck.sendPhoneCode, { phone: NEW })).toEqual({ status: "taken" });
  });

  test("the same number needs nothing", async () => {
    const { t, ada } = await adaWithPhone();
    const { view } = await asPhoneOnly(t, ada);
    expect(await view.action(api.functions.phoneCheck.sendPhoneCode, { phone: OLD })).toEqual({ status: "not_needed" });
  });
});
