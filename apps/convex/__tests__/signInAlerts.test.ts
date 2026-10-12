import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asPhoneOnly, asUser, captureError, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";
import { ALERT_TTL_MS } from "../functions/signInAlerts";
import { TEXTS_CLIENT_ID } from "../functions/textLinks";

/**
 * EVERY SIGN-IN BY PHONE IS TOLD TO EVERY EMAIL (board k3).
 *
 * What must hold: an alert is mailed only for a sign-in that happened, to
 * every confirmed email and nowhere else; its "This wasn't me" link works once
 * and signs every device out, and while phone sign-in is paused the phone
 * signs nobody in, is texted no code, and the texting assistant does not
 * answer it. Only an emailed code turns it back on. Mail is a fake `fetch`.
 */

const PHONE = "+15555550100";

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

async function phoneHolder(t: TestConvex) {
  const ada = await createUser(t, "ada@home.example");
  await t.run(async (ctx) => {
    await ctx.db.patch(ada, { phone: PHONE, phoneVerificationTime: Date.now() });
    await ctx.db.insert("signInEmails", { userId: ada, email: "ada@work.example", addedAt: Date.now() });
  });
  return ada;
}

async function drain(t: TestConvex) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Sign in by phone the way the provider does after Twilio approves, and return the link token. */
async function signInByPhone(t: TestConvex): Promise<{ userId: Id<"users"> | null; token?: string }> {
  vi.useFakeTimers();
  const userId = await t.mutation(internal.functions.phoneSignIn.signInUser, { phone: PHONE });
  await drain(t);
  vi.useRealTimers();
  const link = mails.at(-1)?.text.match(/not-me\?t=([0-9a-f]{64})/);
  return { userId, token: link?.[1] };
}

describe("the alert", () => {
  test("goes to every confirmed email, says which number, and carries a one-time link", async () => {
    const t = setupTest();
    const ada = await phoneHolder(t);
    const { userId, token } = await signInByPhone(t);
    expect(userId).toBe(ada);
    expect(mails.map((m) => m.to).sort()).toEqual(["ada@home.example", "ada@work.example"]);
    expect(mails[0].subject).toBe("New sign-in to your Context");
    expect(mails[0].text).toContain("•••• 0100");
    expect(mails[0].text).not.toContain(PHONE);
    expect(token).toBeDefined();
    const stored = await t.run((ctx) => ctx.db.query("signInAlerts").collect());
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  test("is not sent for a phone nobody holds", async () => {
    const t = setupTest();
    await createUser(t, "ada@home.example");
    expect((await signInByPhone(t)).userId).toBeNull();
    expect(mails).toEqual([]);
  });
});

describe("This wasn't me", () => {
  test("signs every device out, pauses phone sign-in and the texting assistant, and works once", async () => {
    const t = setupTest();
    const ada = await phoneHolder(t);
    await createWorkspace(t, ada, "ada");
    await t.run(async (ctx) => {
      await ctx.db.insert("phoneLinks", { userId: ada, phone: PHONE, linkedAt: Date.now() });
    });
    const thief = await asPhoneOnly(t, ada);
    const { token } = await signInByPhone(t);
    await t.mutation(internal.functions.textLinks.applyTextsGrant, {
      phone: PHONE,
      hashedAccessToken: "a".repeat(64),
      hashedRefreshToken: "b".repeat(64),
      expiresAt: Date.now() + 60_000,
    });

    expect(await t.action(api.functions.signInAlerts.reportNotMe, { token: token! })).toEqual({ status: "done" });
    expect(await t.run((ctx) => ctx.db.get(thief.sessionId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("authSessions").collect())).toEqual([]);
    const grants = await t.run((ctx) => ctx.db.query("oauthGrants").collect());
    expect(grants.filter((g) => g.clientId === TEXTS_CLIENT_ID)).toEqual([]);

    // The phone signs nobody in, is texted nothing, and the assistant goes quiet.
    expect((await signInByPhone(t)).userId).toBeNull();
    expect(await t.mutation(internal.functions.phoneSignIn.reserveSend, { phone: PHONE })).toEqual({ status: "paused" });
    expect(
      await t.mutation(internal.functions.textLinks.applyTextsGrant, {
        phone: PHONE,
        hashedAccessToken: "c".repeat(64),
        hashedRefreshToken: "d".repeat(64),
        expiresAt: Date.now() + 60_000,
      }),
    ).toBe("unlinked");

    // Single use.
    expect(await t.action(api.functions.signInAlerts.reportNotMe, { token: token! })).toEqual({ status: "expired" });
  });

  test("a made-up or expired link does nothing", async () => {
    const t = setupTest();
    const ada = await phoneHolder(t);
    const { token } = await signInByPhone(t);
    expect(await t.action(api.functions.signInAlerts.reportNotMe, { token: "f".repeat(64) })).toEqual({ status: "expired" });
    expect(await t.action(api.functions.signInAlerts.reportNotMe, { token: "not hex" })).toEqual({ status: "expired" });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + ALERT_TTL_MS + 1000);
    expect(await t.action(api.functions.signInAlerts.reportNotMe, { token: token! })).toEqual({ status: "expired" });
    vi.useRealTimers();
    expect(await asUser(t, ada).query(api.functions.signInAlerts.myPhonePause, {})).toEqual({ paused: false });
  });

  test("only an emailed code turns phone sign-in back on", async () => {
    const t = setupTest();
    const ada = await phoneHolder(t);
    const { token } = await signInByPhone(t);
    await t.action(api.functions.signInAlerts.reportNotMe, { token: token! });
    const { view } = await asPhoneOnly(t, ada);
    expect(errorCode(await captureError(() => view.mutation(api.functions.signInAlerts.resumePhoneSignIn, {})))).toBe(
      "EMAIL_PROOF_REQUIRED",
    );
    expect(await view.query(api.functions.signInAlerts.myPhonePause, {})).toEqual({ paused: true });
    await asUser(t, ada).mutation(api.functions.signInAlerts.resumePhoneSignIn, {});
    expect(await view.query(api.functions.signInAlerts.myPhonePause, {})).toEqual({ paused: false });
    expect((await signInByPhone(t)).userId).toBe(ada);
  });
});
