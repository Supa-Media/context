/**
 * SIGNUP ALERTS — `functions/signupAlerts.ts`, its two callers
 * (`waitlist.enter` and `auth.ts`'s `onUserCreated`), and the switch in the
 * staff console (`admin.getSignupAlerts` / `admin.setSignupAlerts`).
 *
 * Dev2 asked (2026-10-03) to hear about every signup. What matters: staff who
 * turned it on get one mail per new waitlist row and per brand-new account,
 * nobody else does, a returning sign-in is not a signup, and somebody taken off
 * `ADMIN_EMAILS` stops getting them without anyone switching them off.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failures in this file.
 *
 *   `onUserCreated` removed from `auth.ts`                             1
 *   recipients not re-checked against `ADMIN_EMAILS`                   1
 *   `setSignupAlerts` without `requireAdmin`                           1
 *   rate limit ignored                                                 1
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { OPEN_SIGNUP_ENV_VAR } from "../functions/lib/waitlist";
import { SIGNUP_ALERTS_PER_HOUR } from "../functions/signupAlerts";
import { asUser, drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";

const STAFF = "staff@context.invalid";
const OTHER_STAFF = "other@context.invalid";
const ORIGIN = "https://context.invalid";
const ENV_KEYS = [
  ADMIN_EMAILS_ENV_VAR,
  OPEN_SIGNUP_ENV_VAR,
  "RESEND_API_KEY",
  "APP_ORIGIN",
  "SITE_URL",
  "CONVEX_SITE_URL",
  "JWT_PRIVATE_KEY",
] as const;

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let previous: Map<string, string | undefined>;
let realFetch: typeof globalThis.fetch;
let mailbox: Mail[];

beforeEach(async () => {
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env[ADMIN_EMAILS_ENV_VAR] = `${STAFF}, ${OTHER_STAFF}`;
  delete process.env[OPEN_SIGNUP_ENV_VAR];
  process.env.RESEND_API_KEY = "re_fake_key_for_tests";
  process.env.APP_ORIGIN = ORIGIN;
  process.env.SITE_URL = ORIGIN;
  process.env.CONVEX_SITE_URL = ORIGIN;
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.JWT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  mailbox = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url !== "https://api.resend.com/emails") throw new Error(`network access attempted: ${url}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Partial<Mail> & { to: string | string[] };
    const to = Array.isArray(body.to) ? body.to : [body.to];
    for (const address of to) {
      mailbox.push({ to: address, subject: body.subject ?? "", text: body.text ?? "", html: body.html ?? "" });
    }
    return new Response(JSON.stringify({ id: "fake-message-id" }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    const was = previous.get(key);
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

function alertsTo(address: string): Mail[] {
  return mailbox.filter((mail) => mail.to === address && /^New (on the waitlist|account): /.test(mail.subject));
}

async function seedUser(t: TestConvex, email: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => ctx.db.insert("users", { email, emailVerificationTime: Date.now() } as never));
}

/** A staff member with alerts switched on. */
async function subscribedStaff(t: TestConvex, email = STAFF) {
  const as = asUser(t, await seedUser(t, email));
  await as.mutation(api.functions.admin.setSignupAlerts, { on: true });
  return as;
}

/** Sign in the way the login field does, reading the code out of the mailbox. */
async function signIn(t: TestConvex, email: string): Promise<void> {
  await t.action(api.auth.signIn, { provider: "email", params: { email } });
  const mail = mailbox.filter((m) => m.to === email && /is your Context code$/.test(m.subject)).at(-1);
  const code = /^(\d{6}) /.exec(mail?.subject ?? "")?.[1];
  expect(code).toBeDefined();
  await t.action(api.auth.signIn, { provider: "email", params: { email, code: code! } });
  await drainScheduled(t);
}

describe("the switch in the staff console", () => {
  test("is off until turned on, and turning it on twice is one subscription", async () => {
    const t = setupTest();
    const as = asUser(t, await seedUser(t, STAFF));
    expect(await as.query(api.functions.admin.getSignupAlerts, {})).toEqual({ on: false, email: STAFF });
    await as.mutation(api.functions.admin.setSignupAlerts, { on: true });
    await as.mutation(api.functions.admin.setSignupAlerts, { on: true });
    expect(await as.query(api.functions.admin.getSignupAlerts, {})).toEqual({ on: true, email: STAFF });
    expect(await t.run(async (ctx) => ctx.db.query("signupAlertSubscribers").collect())).toHaveLength(1);
    await as.mutation(api.functions.admin.setSignupAlerts, { on: false });
    expect(await as.query(api.functions.admin.getSignupAlerts, {})).toEqual({ on: false, email: STAFF });
  });

  test("somebody who is not staff can neither read nor flip it", async () => {
    const t = setupTest();
    const stranger = asUser(t, await seedUser(t, "who@else.test"));
    await expect(stranger.query(api.functions.admin.getSignupAlerts, {})).rejects.toThrow();
    await expect(stranger.mutation(api.functions.admin.setSignupAlerts, { on: true })).rejects.toThrow();
    expect(await t.run(async (ctx) => ctx.db.query("signupAlertSubscribers").collect())).toHaveLength(0);
  });
});

describe("a new waitlist signup", () => {
  test("mails staff who turned alerts on, and nobody else", async () => {
    const t = setupTest();
    await subscribedStaff(t);
    await seedUser(t, OTHER_STAFF); // staff, but never switched it on
    await t.mutation(api.functions.waitlist.enter, { email: "Jon@Studio.test", source: "login" });
    await drainScheduled(t);

    const [alert, ...rest] = alertsTo(STAFF);
    expect(rest).toHaveLength(0);
    expect(alert!.subject).toBe("New on the waitlist: jon@studio.test");
    expect(alert!.text).toContain("sign-in page");
    expect(alert!.text).toContain(`${ORIGIN}/admin`);
    expect(alertsTo(OTHER_STAFF)).toHaveLength(0);
    expect(alertsTo("jon@studio.test")).toHaveLength(0);
    // The person still gets their own "you're on the list".
    expect(mailbox.filter((m) => m.to === "jon@studio.test")).toHaveLength(1);
  });

  test("typing the address again is not another signup", async () => {
    const t = setupTest();
    await subscribedStaff(t);
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    await drainScheduled(t);
    expect(alertsTo(STAFF)).toHaveLength(1);
  });

  test("with nobody subscribed, nothing is scheduled and nothing is spent", async () => {
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    await drainScheduled(t);
    expect(mailbox.filter((m) => /^New /.test(m.subject))).toHaveLength(0);
    const spent = await t.run(async (ctx) =>
      ctx.db.query("rateLimits").withIndex("by_key", (q) => q.eq("key", "signupAlerts")).unique(),
    );
    expect(spent).toBeNull();
  });

  test("past the hourly cap the signup still lands, without an alert", async () => {
    const t = setupTest();
    await subscribedStaff(t);
    await t.run(async (ctx) =>
      ctx.db.insert("rateLimits", { key: "signupAlerts", windowStartedAt: Date.now(), count: SIGNUP_ALERTS_PER_HOUR }),
    );
    expect(await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" })).toMatchObject({ status: "joined" });
    await drainScheduled(t);
    expect(alertsTo(STAFF)).toHaveLength(0);
  });

  test("somebody taken off ADMIN_EMAILS stops getting them", async () => {
    const t = setupTest();
    await subscribedStaff(t);
    process.env[ADMIN_EMAILS_ENV_VAR] = OTHER_STAFF;
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    await drainScheduled(t);
    expect(alertsTo(STAFF)).toHaveLength(0);
  });
});

describe("a new account", () => {
  test("mails subscribed staff once, on the first sign-in only", async () => {
    const t = setupTest();
    await subscribedStaff(t);
    await subscribedStaff(t, OTHER_STAFF);
    const as = asUser(t, (await t.run(async (ctx) =>
      ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", STAFF)).unique(),
    ))!._id);
    await as.mutation(api.functions.admin.addToWaitlist, { emails: "maya@acme.test" });
    await drainScheduled(t);
    mailbox = [];

    await signIn(t, "maya@acme.test");
    for (const staff of [STAFF, OTHER_STAFF]) {
      const alerts = alertsTo(staff);
      expect(alerts.map((m) => m.subject)).toEqual(["New account: maya@acme.test"]);
    }

    mailbox = [];
    await signIn(t, "maya@acme.test");
    expect(alertsTo(STAFF)).toHaveLength(0);
  });
});
