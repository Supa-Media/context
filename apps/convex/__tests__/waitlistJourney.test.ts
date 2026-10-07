/**
 * WAITLIST AND INVITES, END TO END — the private-beta journeys, one person at a
 * time, through the public functions the app calls.
 *
 * `waitlist.test.ts`, `referrals.test.ts` and the invitation suites each pin one
 * step. This file walks the whole way through, so a change that keeps every
 * step green but breaks the hand-off between two of them fails here: somebody
 * joins from the homepage, staff read why and let them in, the "you're in" mail
 * brings them back, they sign in with the code from their mail, make a
 * workspace, take Premium, and bring in a teammate and a friend, each of whom
 * gets in the same way. Staff's counts are checked at the end.
 *
 * Nothing here is seeded that the product could not reach itself, with two
 * named exceptions: the staff account (an `ADMIN_EMAILS` address, which is how
 * every deployment's operator gets in) and one used AI-client grant, which
 * stands in for connecting Claude — the step that unlocks invites and is an
 * OAuth flow outside this backend.
 *
 * Mail goes through a fake Resend: `fetch` is replaced by a mailbox that keeps
 * every message by recipient, so sign-in codes and links are read out of the
 * mail exactly as a person would, and a message that was never sent is a
 * missing message rather than a skipped log line.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failures in this file.
 *
 *   `isAdmitted` admitting every address                              7
 *   `admitRow` not scheduling the "you're in" mail                    1
 *   `describe` dropped (reason never stored)                          1
 *   `communityLinks` returning members-only links when signed out     1
 *   pending workspace invitation no longer admitting its invitee      1
 *   referral clause removed from `isAdmitted`                         2
 *   `activateTestPremium` no longer limited to staging                1
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MAGIC_LINK_PROVIDER_ID } from "@supa-media/convex/auth";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { OPEN_SIGNUP_ENV_VAR } from "../functions/lib/waitlist";
import { asUser, createWorkspace, drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";

const STAFF = "staff@context.invalid";
const ORIGIN = "https://context.invalid";
const ENV_KEYS = [
  ADMIN_EMAILS_ENV_VAR,
  OPEN_SIGNUP_ENV_VAR,
  "RESEND_API_KEY",
  "APP_ORIGIN",
  "SITE_URL",
  "CONVEX_SITE_URL",
  "JWT_PRIVATE_KEY",
  "APP_ENV",
  "STAGING_CONVEX_DEPLOYMENT",
  "CONVEX_CLOUD_URL",
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
  process.env[ADMIN_EMAILS_ENV_VAR] = STAFF;
  // Invite-only, as every real deployment is unless its operator opts out.
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

/** Everything delivered to one address, oldest first. */
function inbox(address: string): Mail[] {
  return mailbox.filter((mail) => mail.to === address);
}

/** The newest mail to `address` whose subject matches, or a failure naming what did arrive. */
function latest(address: string, subject: RegExp): Mail {
  const found = inbox(address).filter((mail) => subject.test(mail.subject)).at(-1);
  if (found === undefined) {
    const got = inbox(address).map((mail) => mail.subject);
    throw new Error(`no mail matching ${subject} to ${address}; got ${JSON.stringify(got)}`);
  }
  return found;
}

/** The first link under this app's origin in a mail, checked present in both alternatives. */
function linkIn(mail: Mail, path: RegExp): URL {
  const links = [...mail.text.matchAll(/https:\/\/[^\s"<>]+/g)].map((match) => new URL(match[0]));
  const link = links.find((url) => url.origin === ORIGIN && path.test(url.pathname));
  if (link === undefined) throw new Error(`no ${path} link in "${mail.subject}"`);
  expect(mail.html).toContain(link.pathname);
  return link;
}

async function userByEmail(t: TestConvex, email: string) {
  return t.run(async (ctx) => ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", email)).unique());
}

/**
 * Sign in the way the login field does: ask for a code, read it out of the
 * mail, type it back. Returns the account it signed into.
 */
async function signInWithMailedCode(t: TestConvex, email: string): Promise<Id<"users">> {
  const before = inbox(email).length;
  await t.action(api.auth.signIn, { provider: "email", params: { email } });
  const mail = inbox(email).slice(before).find((m) => /is your Context code$/.test(m.subject));
  if (mail === undefined) throw new Error(`no sign-in code was mailed to ${email}`);
  const code = /^(\d{6}) /.exec(mail.subject)?.[1];
  expect(code).toBeDefined();
  const result = await t.action(api.auth.signIn, { provider: "email", params: { email, code } });
  expect(result.tokens).not.toBeNull();
  const user = await userByEmail(t, email);
  expect(user).not.toBeNull();
  return user!._id;
}

/** A stranger asking for a code: refused, no mail, no account. */
async function expectRefusedAtSignIn(t: TestConvex, email: string) {
  const before = inbox(email).length;
  await expect(t.action(api.auth.signIn, { provider: "email", params: { email } })).rejects.toThrow();
  expect(inbox(email).length).toBe(before);
  expect(await userByEmail(t, email)).toBeNull();
}

async function signedInStaff(t: TestConvex) {
  // Staff are admitted by the allowlist, so they sign in like anybody else.
  return asUser(t, await signInWithMailedCode(t, STAFF));
}

/** Stands in for the person connecting Claude, which is what unlocks invites. */
async function connectAnAiClient(t: TestConvex, userId: Id<"users">, workspaceId: Id<"workspaces">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId: "journey-ai-client",
      scopes: ["context:read"],
      hashedRefreshToken: `hash-journey-${String(userId)}`,
      status: "active",
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
    });
  });
}

/**
 * The shared first half of every journey: a stranger joins from the homepage
 * with a reason, staff let them in, and they sign in from the mail.
 */
async function joinAndGetLetIn(t: TestConvex, email: string, useFor: string) {
  expect(await t.mutation(api.functions.waitlist.enter, { email, source: "homepage" })).toMatchObject({ status: "joined" });
  await t.mutation(api.functions.waitlist.describe, { email, useFor });
  await drainScheduled(t);
  const staff = await signedInStaff(t);
  const waiting = await staff.query(api.functions.admin.listWaitlist, { status: "waiting" });
  const row = waiting.rows.find((r) => r.email === email)!;
  await staff.mutation(api.functions.admin.admitWaitlist, { ids: [row.id] });
  await drainScheduled(t);
  expect(await t.mutation(api.functions.waitlist.enter, { email, source: "login" })).toEqual({ status: "admitted" });
  return { staff, userId: await signInWithMailedCode(t, email) };
}

describe("joining the waitlist from the homepage", () => {
  test("a stranger joins, is mailed once, can add why, and still cannot sign in", async () => {
    const t = setupTest();
    const email = "jon@studio.test";

    expect(await t.mutation(api.functions.waitlist.enter, { email: "  Jon@Studio.test ", source: "homepage" })).toMatchObject({
      status: "joined",
    });
    await t.mutation(api.functions.waitlist.describe, { email, useFor: "Client notes my agents can read" });
    await drainScheduled(t);

    const joined = latest(email, /waitlist/);
    expect(joined.subject).toBe("You're on the Context.LC waitlist");
    // The page and the mail never carry the address in a link.
    expect(joined.text).not.toContain(encodeURIComponent(email));

    // Typing it again says "already", and mails nobody.
    expect(await t.mutation(api.functions.waitlist.enter, { email, source: "homepage" })).toEqual({ status: "already" });
    await drainScheduled(t);
    expect(inbox(email)).toHaveLength(1);

    // The page drawing "you're on the list" is not the lock; the server is.
    await expectRefusedAtSignIn(t, email);
  });
});

describe("staff see the list and let people in", () => {
  test("the reason and where they came from reach staff, and Let in sends them back in", async () => {
    const t = setupTest();
    const email = "ana@kiln.test";
    await t.mutation(api.functions.waitlist.enter, { email, source: "homepage" });
    await t.mutation(api.functions.waitlist.describe, { email, useFor: "Running a pottery studio" });
    await t.mutation(api.functions.waitlist.enter, { email: "lee@forge.test", source: "login" });

    const staff = await signedInStaff(t);
    const waiting = await staff.query(api.functions.admin.listWaitlist, { status: "waiting" });
    expect(waiting.counts).toEqual({ waiting: 2, admitted: 0 });
    const ana = waiting.rows.find((row) => row.email === email)!;
    expect(ana).toMatchObject({ source: "homepage", useFor: "Running a pottery studio", status: "waiting" });
    expect(waiting.rows.find((row) => row.email === "lee@forge.test")).toMatchObject({ source: "login", useFor: null });

    await staff.mutation(api.functions.admin.admitWaitlist, { ids: [ana.id] });
    await drainScheduled(t);
    const letIn = await staff.query(api.functions.admin.listWaitlist, { status: "admitted" });
    expect(letIn.counts).toEqual({ waiting: 1, admitted: 1 });
    expect(letIn.rows[0]).toMatchObject({ email, status: "admitted" });
    expect(letIn.rows[0]!.admittedAt).toBeTypeOf("number");

    // "You're in" takes them to the sign-in page, and the code works.
    const youreIn = latest(email, /^You're in$/);
    expect(linkIn(youreIn, /^\/login$/).search).toBe("");
    const userId = await signInWithMailedCode(t, email);
    expect(await asUser(t, userId).query(api.functions.admin.amIAdmin, {})).toBe(false);

    // Whoever is still waiting is still refused.
    await expectRefusedAtSignIn(t, "lee@forge.test");
  });

  test("somebody who is not staff cannot read or change the list", async () => {
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "ana@kiln.test" });
    const { userId } = await joinAndGetLetIn(t, "maya@acme.test", "Agency");
    const member = asUser(t, userId);
    await expect(member.query(api.functions.admin.listWaitlist, { status: "waiting" })).rejects.toThrow();
    await expect(member.mutation(api.functions.admin.addToWaitlist, { emails: "me@else.test" })).rejects.toThrow();
    await expectRefusedAtSignIn(t, "ana@kiln.test");
    await expectRefusedAtSignIn(t, "me@else.test");
  });
});

describe("the Discord link is set in the admin dashboard", () => {
  test("staff set it once and it reaches members, never signed-out visitors", async () => {
    const t = setupTest();
    const staff = await signedInStaff(t);
    const discord = "https://discord.gg/example-invite";
    await staff.mutation(api.functions.admin.saveCommunityLink, {
      kind: "discord",
      label: "Join the Discord",
      url: discord,
      audience: "members",
    });
    expect((await staff.query(api.functions.admin.listCommunityLinks, {})).map((link) => link.url)).toEqual([discord]);

    expect(await t.query(api.functions.referrals.communityLinks, {})).toEqual([]);
    const { userId } = await joinAndGetLetIn(t, "maya@acme.test", "Agency");
    const seen = await asUser(t, userId).query(api.functions.referrals.communityLinks, {});
    expect(seen).toMatchObject([{ kind: "discord", url: discord, audience: "members" }]);

    await expect(
      asUser(t, userId).mutation(api.functions.admin.saveCommunityLink, {
        kind: "discord",
        label: "Mine",
        url: "https://discord.gg/not-yours",
        audience: "everyone",
      }),
    ).rejects.toThrow();
  });
});

describe("off the waitlist: an account, a workspace, and bringing people in", () => {
  test("a teammate invited to the business workspace gets in from the invitation alone", async () => {
    const t = setupTest();
    const { userId: maya } = await joinAndGetLetIn(t, "maya@acme.test", "Agency client notes");
    await createWorkspace(t, maya, "maya", { displayName: "Maya" });
    const acme = await createWorkspace(t, maya, "acme-studio", { kind: "shared", displayName: "Acme Studio" });

    const teammate = "sam@acme.test";
    await expectRefusedAtSignIn(t, teammate);
    await asUser(t, maya).mutation(api.functions.invitations.inviteMember, {
      workspaceId: acme,
      invitee: teammate,
      role: "editor",
    });
    await drainScheduled(t);

    // The invitation is the teammate's way in: the field says so, and they
    // never touch the waitlist.
    expect(await t.mutation(api.functions.waitlist.enter, { email: teammate })).toEqual({ status: "admitted" });

    // The link in the mail signs them in on click, then they accept.
    const link = linkIn(latest(teammate, /./), /^\/invite\//);
    const code = link.searchParams.get("code");
    expect(code).not.toBeNull();
    const signedIn = await t.action(api.auth.signIn, { provider: MAGIC_LINK_PROVIDER_ID, params: { code: code! } });
    expect(signedIn.tokens).not.toBeNull();
    const sam = (await userByEmail(t, teammate))!._id;
    const token = decodeURIComponent(link.pathname.slice("/invite/".length));
    expect(await asUser(t, sam).mutation(api.functions.invitations.acceptInvitation, { token })).toMatchObject({
      workspaceId: acme,
      role: "editor",
    });

    const members = await asUser(t, maya).query(api.functions.workspaces.listMembers, { workspaceId: acme });
    expect(members.map((member) => member.role).sort()).toEqual(["editor", "owner"]);
    expect(await t.run(async (ctx) => ctx.db.query("waitlist").collect())).toHaveLength(1);
  });

  test("somebody let in starts free and can take Premium, which staging gives without a card", async () => {
    const t = setupTest();
    const { userId: maya } = await joinAndGetLetIn(t, "maya@acme.test", "Agency client notes");
    const acme = await createWorkspace(t, maya, "acme-studio", { kind: "shared", displayName: "Acme Studio" });
    const owner = asUser(t, maya);
    expect(await owner.query(api.functions.billing.status, { workspaceId: acme })).toMatchObject({ status: "none" });

    // Outside staging the only way to Premium is checkout: the free upgrade is
    // refused however the account got in.
    await expect(owner.mutation(api.functions.billing.activateTestPremium, { workspaceId: acme })).rejects.toMatchObject({
      data: expect.objectContaining({ code: "FORBIDDEN" }),
    });

    process.env.APP_ENV = "staging";
    process.env.APP_ORIGIN = "https://staging.context.lc";
    process.env.STAGING_CONVEX_DEPLOYMENT = "example-deployment";
    process.env.CONVEX_CLOUD_URL = "https://example-deployment.convex.cloud";
    expect(await owner.mutation(api.functions.billing.activateTestPremium, { workspaceId: acme })).toEqual({ active: true });
    expect(await owner.query(api.functions.billing.status, { workspaceId: acme })).toMatchObject({
      status: "active",
      active: { fastSearch: true },
    });
  });

  test("a friend invited to Context gets in, and staff can trace who brought whom", async () => {
    const t = setupTest();
    const { staff, userId: maya } = await joinAndGetLetIn(t, "maya@acme.test", "Agency client notes");
    const personal = await createWorkspace(t, maya, "maya", { displayName: "Maya" });

    // Invites unlock once one of her AI tools has actually connected.
    expect((await asUser(t, maya).query(api.functions.referrals.mine, {}))?.locked).toBe("setup");
    await connectAnAiClient(t, maya, personal);
    const mine = await asUser(t, maya).query(api.functions.referrals.mine, {});
    expect(mine).toMatchObject({ locked: null, total: 3, left: 3 });

    const friend = "jon@studio.test";
    await expectRefusedAtSignIn(t, friend);
    expect(await asUser(t, maya).mutation(api.functions.referrals.send, { email: friend })).toEqual({ status: "sent" });
    await drainScheduled(t);

    const invite = latest(friend, /invited you to Context\.LC/);
    expect(invite.subject).toBe("@maya invited you to Context.LC");
    const joinLink = linkIn(invite, /^\/join\//);
    const token = joinLink.pathname.slice("/join/".length);
    expect(await t.query(api.functions.referrals.preview, { token })).toEqual({ works: true, inviterHandle: "maya" });

    expect(await t.mutation(api.functions.waitlist.enter, { email: friend })).toEqual({ status: "admitted" });
    const jon = await signInWithMailedCode(t, friend);
    await createWorkspace(t, jon, "jon", { displayName: "Jon" });

    const after = await asUser(t, maya).query(api.functions.referrals.mine, {});
    expect(after?.left).toBe(2);
    expect(after?.invites).toMatchObject([{ email: friend, status: "joined", joinedHandle: "jon" }]);
    // A used invite no longer opens anything.
    expect(await t.query(api.functions.referrals.preview, { token })).toEqual({ works: false, inviterHandle: null });

    const referrals = await staff.query(api.functions.admin.listReferrals, {});
    expect(referrals.counts).toMatchObject({ pending: 0, joined: 1 });
    const traced = await staff.query(api.functions.admin.traceReferral, { inviteId: referrals.rows[0]!.id });
    expect(traced).toMatchObject({ email: friend, status: "joined", inviterHandle: "maya", joinedHandle: "jon" });
  });
});

describe("staff's numbers after a beta cohort", () => {
  test("waiting, let in, and joined through friends each add up", async () => {
    const t = setupTest();
    for (const email of ["a@wait.test", "b@wait.test", "c@wait.test"]) {
      await t.mutation(api.functions.waitlist.enter, { email, source: "homepage" });
    }
    const { staff, userId: maya } = await joinAndGetLetIn(t, "maya@acme.test", "Agency");
    const personal = await createWorkspace(t, maya, "maya", { displayName: "Maya" });
    await connectAnAiClient(t, maya, personal);
    await asUser(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    await asUser(t, maya).mutation(api.functions.referrals.send, { email: "kim@studio.test" });
    await drainScheduled(t);
    await signInWithMailedCode(t, "jon@studio.test");

    const waitlist = await staff.query(api.functions.admin.listWaitlist, { status: "waiting" });
    expect(waitlist.counts).toEqual({ waiting: 3, admitted: 1 });
    const referrals = await staff.query(api.functions.admin.listReferrals, {});
    expect(referrals.counts).toMatchObject({ pending: 1, joined: 1 });
  });
});
