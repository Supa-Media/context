import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asPhoneOnly, asUser, captureError, createUser, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { RECOVERY_WAIT_MS } from "../functions/emailRecovery";

/**
 * LOST EVERY EMAIL: A NEW ONE WAITS SEVEN DAYS (board k4).
 *
 * What must hold: a phone alone can start it but never finish it early; the
 * new address is proven by its own code first; every current email is told at
 * once with a link that stops it; and only when the week is up does the new
 * address join the account, after which it can confirm big changes.
 */

const CODE = "112233";

type Mail = { to: string; subject: string; text: string };
let mails: Mail[];

beforeEach(() => {
  mails = [];
  vi.stubEnv("RESEND_API_KEY", "re_test_not_real");
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    if (url.startsWith("https://api.resend.com/")) mails.push(JSON.parse(init.body) as Mail);
    return new Response("{}", { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type View = Awaited<ReturnType<typeof asPhoneOnly>>["view"];

async function start(t: TestConvex, view: View, userId: Id<"users">, email = "ada@new.example") {
  const started = await view.action(api.functions.emailRecovery.startEmailRecovery, { email });
  if (started.status === "sent") {
    const hashed = await hashToken(CODE);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("emailRecoveryCodes")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();
      await ctx.db.patch(row!._id, { hashedCode: hashed });
    });
  }
  return started;
}

async function begin(t: TestConvex) {
  const ada = await createUser(t, "ada@home.example");
  const phone = await asPhoneOnly(t, ada);
  expect((await start(t, phone.view, ada)).status).toBe("sent");
  vi.useFakeTimers();
  const confirmed = await phone.view.action(api.functions.emailRecovery.confirmEmailRecovery, { code: CODE });
  await t.finishInProgressScheduledFunctions();
  vi.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  expect(confirmed.status).toBe("started");
  const notice = mails.find((m) => m.to === "ada@home.example");
  const cancelToken = notice?.text.match(/stop-new-email\?token=([0-9a-f]{64})/)?.[1];
  return { ada, phone, cancelToken };
}

async function emailsOf(t: TestConvex, userId: Id<"users">) {
  return await asUser(t, userId).query(api.functions.signInEmails.myEmails, {});
}

describe("starting", () => {
  test("the new address gets a code; the current one is told, with a link to stop it", async () => {
    const t = setupTest();
    const { ada, cancelToken } = await begin(t);
    expect(mails.find((m) => m.to === "ada@new.example")?.subject).toMatch(/is your Context code/);
    const notice = mails.find((m) => m.to === "ada@home.example");
    expect(notice?.text).toContain("a•••@new.example");
    expect(cancelToken).toBeDefined();
    const waiting = await asUser(t, ada).query(api.functions.emailRecovery.myEmailRecovery, {});
    expect(waiting?.email).toBe("ada@new.example");
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("emailRecoveries").collect()))).not.toContain(cancelToken);
  });

  test("not for an address another account has", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    await createUser(t, "bob@home.example");
    const { view } = await asPhoneOnly(t, ada);
    expect(await start(t, view, ada, "bob@home.example")).toEqual({ status: "taken" });
  });

  test("an account with no email adds its first one the ordinary way", async () => {
    const t = setupTest();
    const phoneMade = await t.run((ctx) =>
      ctx.db.insert("users", { phone: "+15555550111", phoneVerificationTime: Date.now(), createdAt: Date.now() }),
    );
    const { view } = await asPhoneOnly(t, phoneMade);
    expect(await start(t, view, phoneMade)).toEqual({ status: "not_needed" });
  });
});

describe("the wait", () => {
  test("nothing is added before seven days; after it the address is the person's and can prove big changes", async () => {
    const t = setupTest();
    const { ada } = await begin(t);
    vi.setSystemTime(Date.now() + RECOVERY_WAIT_MS - 60_000);
    expect(await t.mutation(internal.functions.emailRecovery.finishDue, {})).toEqual({ finished: 0 });
    expect((await emailsOf(t, ada)).map((e) => e.email)).toEqual(["ada@home.example"]);
    vi.setSystemTime(Date.now() + 120_000);
    expect(await t.mutation(internal.functions.emailRecovery.finishDue, {})).toEqual({ finished: 1 });
    expect((await emailsOf(t, ada)).map((e) => e.email)).toEqual(["ada@home.example", "ada@new.example"]);
    const { view } = await asPhoneOnly(t, ada);
    expect((await view.query(api.functions.emailProof.myEmailProof, {})).emails).toContain("a•••@new.example");
  });

  test("\"This wasn't me\" stops the recovery the intruder started", async () => {
    // The alarm link signs every device out and pauses the phone, and the
    // person who clicks it has been told that is what it does. A waiting
    // recovery is the one thing a phone-only session can start that outlives
    // the session, so it has to go the same way: otherwise the account is
    // taken a week later by somebody the owner already locked out.
    const t = setupTest();
    const { ada } = await begin(t);
    const token = "f".repeat(64);
    await t.run(async (ctx) => {
      await ctx.db.patch(ada, { phone: "+15555550100", phoneVerificationTime: Date.now() });
      await ctx.db.insert("signInAlerts", {
        userId: ada,
        hashedToken: await hashToken(token),
        at: Date.now(),
        phoneLast4: "0100",
        expiresAt: Date.now() + 60 * 60 * 1000,
      });
    });

    expect(await t.action(api.functions.signInAlerts.reportNotMe, { token })).toEqual({ status: "done" });

    expect(await asUser(t, ada).query(api.functions.emailRecovery.myEmailRecovery, {})).toBeNull();
    vi.setSystemTime(Date.now() + RECOVERY_WAIT_MS + 60_000);
    expect(await t.mutation(internal.functions.emailRecovery.finishDue, {})).toEqual({ finished: 0 });
    expect((await emailsOf(t, ada)).map((e) => e.email)).not.toContain("ada@new.example");
  });

  test("the link in the notice stops it, once", async () => {
    const t = setupTest();
    const { ada, cancelToken } = await begin(t);
    expect(await t.action(api.functions.emailRecovery.cancelByLink, { token: cancelToken! })).toEqual({ status: "cancelled" });
    expect(await t.action(api.functions.emailRecovery.cancelByLink, { token: cancelToken! })).toEqual({ status: "expired" });
    vi.setSystemTime(Date.now() + RECOVERY_WAIT_MS + 60_000);
    expect(await t.mutation(internal.functions.emailRecovery.finishDue, {})).toEqual({ finished: 0 });
    expect(await asUser(t, ada).query(api.functions.emailRecovery.myEmailRecovery, {})).toBeNull();
  });

  test("the phone alone cannot stop someone else's wait, but an emailed code can", async () => {
    const t = setupTest();
    const { ada } = await begin(t);
    const other = await asPhoneOnly(t, ada);
    expect(errorCode(await captureError(() => other.view.mutation(api.functions.emailRecovery.cancelMine, {})))).toBe(
      "EMAIL_PROOF_REQUIRED",
    );
    await asUser(t, ada).mutation(api.functions.emailRecovery.cancelMine, {});
    expect(await asUser(t, ada).query(api.functions.emailRecovery.myEmailRecovery, {})).toBeNull();
  });

  test("one at a time", async () => {
    const t = setupTest();
    const { ada, phone } = await begin(t);
    vi.useRealTimers();
    expect(await start(t, phone.view, ada, "ada@other.example")).toEqual({ status: "waiting" });
  });

  test("an address taken by someone else meanwhile is not added", async () => {
    const t = setupTest();
    const { ada } = await begin(t);
    await createUser(t, "ada@new.example");
    vi.setSystemTime(Date.now() + RECOVERY_WAIT_MS + 60_000);
    expect(await t.mutation(internal.functions.emailRecovery.finishDue, {})).toEqual({ finished: 0 });
    expect((await emailsOf(t, ada)).map((e) => e.email)).toEqual(["ada@home.example"]);
  });
});
