import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asPhoneOnly, asUser, captureError, createUser, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";
import {
  FRESH_SIGNUP_WINDOW_MS,
  isFreshSingleEmailAccount,
} from "../functions/lib/freshSignup";
import { hashToken } from "../functions/lib/crypto";

/**
 * ADDING A PERSONAL EMAIL RIGHT AFTER A DOMAIN SIGN-UP (signInEmails.ts).
 *
 * An account made a moment ago, holding only the address it signed up with,
 * may add one more without a code sent to the first: the person has just
 * signed up and is setting up their own address (accountSetup.ts). Once it
 * has two confirmed addresses, or the window has passed, adding needs proof
 * like any other account.
 */

const CODE = "246810";
const PROOF = "EMAIL_PROOF_REQUIRED";
const MINUTE = 60 * 1000;

afterEach(() => vi.useRealTimers());

async function start(t: TestConvex, userId: Id<"users">, email: string) {
  const phone = await asPhoneOnly(t, userId);
  const started = await phone.view.action(api.functions.signInEmails.startAddEmail, { email });
  if (started.status === "sent") {
    const hashed = await hashToken(CODE);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("signInEmailCodes")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();
      await ctx.db.patch(row!._id, { hashedCode: hashed });
    });
  }
  return started;
}

describe("the window", () => {
  test("a fresh account with one confirmed address may start adding without proof", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    expect((await start(t, ada, "ada@work.example")).status).toBe("sent");
  });

  test("a fresh account adds a second address without proof, and the code attaches it", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    expect((await start(t, ada, "ada@work.example")).status).toBe("sent");
    const phone = await asPhoneOnly(t, ada);
    expect(await phone.view.action(api.functions.signInEmails.confirmAddEmail, { code: CODE })).toEqual({
      status: "added",
    });
  });

  test("an account older than the window needs proof to add an address", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2030-01-01T10:00:00Z") });
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    vi.setSystemTime(Date.now() + 31 * MINUTE);
    const phone = await asPhoneOnly(t, ada);
    const error = await captureError(() =>
      phone.view.action(api.functions.signInEmails.startAddEmail, { email: "ada@work.example" }),
    );
    expect(errorCode(error)).toBe(PROOF);
  });

  test("a fresh account that already added a second address needs proof for a third", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    // The second address is added from a session that has proven its email.
    expect((await start(t, ada, "ada@work.example")).status).toBe("sent");
    const proven = asUser(t, ada);
    expect(await proven.action(api.functions.signInEmails.confirmAddEmail, { code: CODE })).toEqual({ status: "added" });
    const phone = await asPhoneOnly(t, ada);
    const error = await captureError(() =>
      phone.view.action(api.functions.signInEmails.startAddEmail, { email: "ada@third.example" }),
    );
    expect(errorCode(error)).toBe(PROOF);
  });
});

describe("the pure rule", () => {
  const base = { createdAt: 1_000_000, confirmedCount: 1, attachedCount: 0 };

  test("the window is thirty minutes", () => {
    expect(FRESH_SIGNUP_WINDOW_MS).toBe(30 * MINUTE);
  });

  test("exempt at exactly thirty minutes, not a millisecond after", () => {
    expect(isFreshSingleEmailAccount({ ...base, now: base.createdAt + 30 * MINUTE })).toBe(true);
    expect(isFreshSingleEmailAccount({ ...base, now: base.createdAt + 30 * MINUTE + 1 })).toBe(false);
  });

  test("not exempt with two confirmed addresses, or an attached one", () => {
    expect(isFreshSingleEmailAccount({ ...base, now: base.createdAt, confirmedCount: 2, attachedCount: 1 })).toBe(false);
    expect(isFreshSingleEmailAccount({ ...base, now: base.createdAt, confirmedCount: 1, attachedCount: 1 })).toBe(false);
  });

  test("not exempt with no confirmed address at all", () => {
    expect(isFreshSingleEmailAccount({ ...base, now: base.createdAt, confirmedCount: 0, attachedCount: 0 })).toBe(false);
  });
});
