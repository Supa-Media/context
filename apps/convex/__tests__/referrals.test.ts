/**
 * REFERRALS — `functions/referrals.ts`, `functions/lib/referrals.ts`, the
 * referral half of `functions/admin.ts`, and the referral clause of
 * `isAdmitted`.
 *
 * What matters: an invite lets exactly one address in, for 14 days, and a
 * person can only spend the invites they have; nothing here tells an inviter
 * who else invited an address; staff can stop an invite and nobody else can.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failures in this file.
 *
 *   `hasLiveInvite` ignoring `expiresAt`                               1
 *   `usesAnInvite` counting cancelled invites                          1
 *   `send` checking `isAdmitted` instead of `isAdmittedWithoutReferral` 2
 *   `cancel` not checking the inviter                                  1
 *   `allowanceFor` skipping the friend wait                            1
 *   `communityLinks` returning members links signed out                1
 *   `claimMail` skipping the per-recipient limit                       1
 *   `claimMail` not setting `mailedAt`                                 1
 *   `undoCancel` not checking for an account                           1
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { allowanceFor, FRIEND_WAIT_MS, INVITE_TTL_MS, SENDS_PER_DAY } from "../functions/lib/referrals";
import { isAdmitted, OPEN_SIGNUP_ENV_VAR } from "../functions/lib/waitlist";
import { setupTest, type TestConvex } from "./fixtures.helpers";

const STAFF = "staff@context.invalid";
const ENV_KEYS = [ADMIN_EMAILS_ENV_VAR, OPEN_SIGNUP_ENV_VAR, "RESEND_API_KEY"] as const;
let previous: Map<string, string | undefined>;

beforeEach(() => {
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env[ADMIN_EMAILS_ENV_VAR] = STAFF;
  delete process.env[OPEN_SIGNUP_ENV_VAR];
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const was = previous.get(key);
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

async function seedUser(t: TestConvex, email: string): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { email, emailVerificationTime: Date.now() } as never),
  );
}

/** An account whose AI client has called: setup finished, invites unlocked. */
async function setUpUser(t: TestConvex, email: string): Promise<Id<"users">> {
  const userId = await seedUser(t, email);
  await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: email.split("@")[0],
      displayName: "Mine",
      createdBy: userId,
      kind: "personal",
      structureTemplate: "para",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
    await ctx.db.insert("workspaceMembers", { workspaceId, userId, role: "owner", joinedAt: Date.now() } as never);
    await ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId: "claude",
      scopes: [],
      hashedRefreshToken: `h-${email}`,
      status: "active",
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
    });
  });
  return userId;
}

const as = (t: TestConvex, userId: Id<"users">) => t.withIdentity({ subject: userId });
const admitted = (t: TestConvex, email: string, now = Date.now()) =>
  t.run(async (ctx) => isAdmitted(ctx.db, email, process.env, now));
const invites = (t: TestConvex) => t.run(async (ctx) => ctx.db.query("referralInvites").collect());

describe("sending an invite", () => {
  test("nobody can invite until one of their AI tools has called", async () => {
    const t = setupTest();
    const fresh = await seedUser(t, "fresh@acme.test");
    await expect(as(t, fresh).mutation(api.functions.referrals.send, { email: "jon@studio.test" })).rejects.toThrow(
      /Finish setting up/,
    );
    expect((await as(t, fresh).query(api.functions.referrals.mine, {}))?.locked).toBe("setup");
  });

  test("an invite lets one address in, and uses one of three", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    expect(await admitted(t, "jon@studio.test")).toBe(false);
    expect(await as(t, maya).mutation(api.functions.referrals.send, { email: " Jon@Studio.test " })).toEqual({
      status: "sent",
    });
    expect(await admitted(t, "jon@studio.test")).toBe(true);
    expect(await admitted(t, "someone@else.test")).toBe(false);
    const mine = await as(t, maya).query(api.functions.referrals.mine, {});
    expect(mine?.left).toBe(2);
    expect(mine?.invites.map((row) => [row.email, row.status])).toEqual([["jon@studio.test", "pending"]]);
  });

  test("sending twice to one address mails once and uses one", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    await as(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    expect(await invites(t)).toHaveLength(1);
  });

  test("an address already let in costs nothing", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    await seedUser(t, "sam@acme.test");
    expect(await as(t, maya).mutation(api.functions.referrals.send, { email: "sam@acme.test" })).toEqual({
      status: "already",
    });
    expect(await invites(t)).toHaveLength(0);
  });

  test("an address somebody else invited reads like any other", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    const lee = await setUpUser(t, "lee@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "ana@kiln.test" });
    expect(await as(t, lee).mutation(api.functions.referrals.send, { email: "ana@kiln.test" })).toEqual({
      status: "sent",
    });
    expect(await invites(t)).toHaveLength(2);
  });

  test("the fourth invite is refused; cancelling one frees it and Undo takes it back", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    for (const email of ["a@x.test", "b@x.test", "c@x.test"]) {
      await as(t, maya).mutation(api.functions.referrals.send, { email });
    }
    await expect(as(t, maya).mutation(api.functions.referrals.send, { email: "d@x.test" })).rejects.toThrow(
      /used all your invites/,
    );
    const first = (await invites(t)).find((row) => row.email === "a@x.test")!;
    expect(await as(t, maya).mutation(api.functions.referrals.cancel, { inviteId: first._id })).toEqual({ changed: true });
    expect(await admitted(t, "a@x.test")).toBe(false);
    expect((await as(t, maya).query(api.functions.referrals.mine, {}))?.left).toBe(1);
    expect(await as(t, maya).mutation(api.functions.referrals.undoCancel, { inviteId: first._id })).toEqual({
      changed: true,
    });
    expect(await admitted(t, "a@x.test")).toBe(true);
    expect((await as(t, maya).query(api.functions.referrals.mine, {}))?.left).toBe(0);
  });

  test("somebody else's invite cannot be cancelled", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    const lee = await setUpUser(t, "lee@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    const [invite] = await invites(t);
    expect(await as(t, lee).mutation(api.functions.referrals.cancel, { inviteId: invite._id })).toEqual({
      changed: false,
    });
    expect(await admitted(t, "jon@studio.test")).toBe(true);
  });

  test("an invite stops letting anybody in after 14 days, and comes back", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    const later = Date.now() + INVITE_TTL_MS + 1;
    expect(await admitted(t, "jon@studio.test", later)).toBe(false);
    const allowance = await t.run(async (ctx) => allowanceFor(ctx.db, maya, later));
    expect(allowance.left).toBe(3);
  });

  test("a daily cap holds even for somebody staff gave plenty", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    await t.run(async (ctx) => ctx.db.insert("referralAllowances", { userId: maya, extra: 50, updatedAt: Date.now() }));
    for (let i = 0; i < SENDS_PER_DAY; i += 1) {
      await as(t, maya).mutation(api.functions.referrals.send, { email: `f${i}@x.test` });
    }
    await expect(as(t, maya).mutation(api.functions.referrals.send, { email: "late@x.test" })).rejects.toThrow(
      /Too many requests/,
    );
  });

  test("while invites are switched off nobody can send, and live ones still work", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    const staff = as(t, await seedUser(t, STAFF));
    await staff.mutation(api.functions.admin.setInvitesOff, { off: true });
    await expect(as(t, maya).mutation(api.functions.referrals.send, { email: "x@x.test" })).rejects.toThrow(/paused/);
    expect(await admitted(t, "jon@studio.test")).toBe(true);
  });
});

describe("when the friend joins", () => {
  test("the oldest invite gets the credit; the other comes back to its sender", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    const lee = await setUpUser(t, "lee@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "ana@kiln.test" });
    await as(t, lee).mutation(api.functions.referrals.send, { email: "ana@kiln.test" });
    await seedUser(t, "ana@kiln.test");
    const mayas = await as(t, maya).query(api.functions.referrals.mine, {});
    const lees = await as(t, lee).query(api.functions.referrals.mine, {});
    expect(mayas?.invites[0].status).toBe("joined");
    expect(mayas?.left).toBe(2);
    expect(lees?.invites[0].status).toBe("expired");
    expect(lees?.left).toBe(3);
  });

  test("somebody let in by a friend waits seven days before inviting", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    const jon = await setUpUser(t, "jon@studio.test");
    const now = await t.run(async (ctx) => allowanceFor(ctx.db, jon, Date.now()));
    expect(now.locked).toBe("new");
    const later = await t.run(async (ctx) => allowanceFor(ctx.db, jon, Date.now() + FRIEND_WAIT_MS + 1));
    expect(later.locked).toBeNull();
  });

  test("Undo cannot bring an invite back once the address has joined", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    const [invite] = await invites(t);
    await as(t, maya).mutation(api.functions.referrals.cancel, { inviteId: invite._id });
    await seedUser(t, "jon@studio.test");
    expect(await as(t, maya).mutation(api.functions.referrals.undoCancel, { inviteId: invite._id })).toEqual({
      changed: false,
    });
    const mine = await as(t, maya).query(api.functions.referrals.mine, {});
    expect(mine?.invites.map((row) => row.status)).toEqual(["cancelled"]);
  });
});

describe("invite mail", () => {
  const claim = (t: TestConvex, inviteId: Id<"referralInvites">) =>
    t.mutation(internal.functions.referrals.claimMail, { inviteId });

  test("each invite is mailed at most once, and only while it is live", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    await as(t, maya).mutation(api.functions.referrals.send, { email: "ana@kiln.test" });
    const [jon, ana] = await invites(t);
    expect((await claim(t, jon._id))?.email).toBe("jon@studio.test");
    expect(await claim(t, jon._id)).toBeNull();
    await as(t, maya).mutation(api.functions.referrals.cancel, { inviteId: ana._id });
    expect(await claim(t, ana._id)).toBeNull();
  });

  test("one address gets three invite emails a day, however many people invite it", async () => {
    const t = setupTest();
    const senders: Array<Id<"users">> = [];
    for (const name of ["maya", "lee", "sam", "kai"]) senders.push(await setUpUser(t, `${name}@acme.test`));
    for (const sender of senders) {
      await as(t, sender).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    }
    const claimed = [];
    for (const invite of await invites(t)) claimed.push(await claim(t, invite._id));
    expect(claimed.filter((row) => row !== null)).toHaveLength(3);
    // The limit is on mail, never on the invite: every one still lets jon in.
    expect(await admitted(t, "jon@studio.test")).toBe(true);
  });
});

describe("the join page", () => {
  test("says who invited you while the invite works, and nothing once it doesn't", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    const [invite] = await invites(t);
    expect(await t.query(api.functions.referrals.preview, { token: invite.token })).toEqual({
      works: true,
      inviterHandle: "maya",
    });
    const staff = as(t, await seedUser(t, STAFF));
    await staff.mutation(api.functions.admin.revokeReferral, { inviteId: invite._id });
    const dead = await t.query(api.functions.referrals.preview, { token: invite.token });
    const unknown = await t.query(api.functions.referrals.preview, { token: "nope" });
    expect(dead).toEqual(unknown);
  });
});

describe("staff", () => {
  test("revoke stops an invite, keeps it used, and is staff only", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    const [invite] = await invites(t);
    await expect(as(t, maya).mutation(api.functions.admin.revokeReferral, { inviteId: invite._id })).rejects.toThrow();
    const staff = as(t, await seedUser(t, STAFF));
    expect(await staff.mutation(api.functions.admin.revokeReferral, { inviteId: invite._id })).toEqual({ changed: true });
    expect(await admitted(t, "jon@studio.test")).toBe(false);
    expect((await as(t, maya).query(api.functions.referrals.mine, {}))?.left).toBe(2);
    const list = await staff.query(api.functions.admin.listReferrals, {});
    expect(list.counts.revoked).toBe(1);
    expect(list.rows[0].inviterHandle).toBe("maya");
  });

  test("a used invite cannot be revoked, and the trace shows who joined", async () => {
    const t = setupTest();
    const maya = await setUpUser(t, "maya@acme.test");
    await as(t, maya).mutation(api.functions.referrals.send, { email: "jon@studio.test" });
    const [invite] = await invites(t);
    await setUpUser(t, "jon@studio.test");
    const staff = as(t, await seedUser(t, STAFF));
    expect(await staff.mutation(api.functions.admin.revokeReferral, { inviteId: invite._id })).toEqual({
      changed: false,
    });
    const trace = await staff.query(api.functions.admin.traceReferral, { inviteId: invite._id });
    expect(trace?.status).toBe("joined");
    expect(trace?.joinedHandle).toBe("jon");
  });

  test("giving more invites unlocks and adds", async () => {
    const t = setupTest();
    const fresh = await seedUser(t, "fresh@acme.test");
    const staff = as(t, await seedUser(t, STAFF));
    await staff.mutation(api.functions.admin.grantInvites, { userId: fresh, add: 2 });
    const mine = await as(t, fresh).query(api.functions.referrals.mine, {});
    expect(mine?.locked).toBeNull();
    expect(mine?.left).toBe(5);
    await expect(staff.mutation(api.functions.admin.grantInvites, { userId: fresh, add: 0 })).rejects.toThrow();
  });
});

describe("community links", () => {
  test("members links go only to somebody signed in, and only https is kept", async () => {
    const t = setupTest();
    const staff = as(t, await seedUser(t, STAFF));
    await staff.mutation(api.functions.admin.saveCommunityLink, {
      kind: "discord",
      label: "Discord",
      url: "https://discord.gg/example",
      audience: "members",
    });
    await staff.mutation(api.functions.admin.saveCommunityLink, {
      kind: "github",
      label: "GitHub",
      url: "https://github.com/example/example",
      audience: "everyone",
    });
    await expect(
      staff.mutation(api.functions.admin.saveCommunityLink, {
        kind: "other",
        label: "Bad",
        url: "javascript:alert(1)",
        audience: "everyone",
      }),
    ).rejects.toThrow(/https/);
    const signedOut = await t.query(api.functions.referrals.communityLinks, {});
    expect(signedOut.map((row) => row.kind)).toEqual(["github"]);
    const maya = await seedUser(t, "maya@acme.test");
    const signedIn = await as(t, maya).query(api.functions.referrals.communityLinks, {});
    expect(signedIn.map((row) => row.kind)).toEqual(["discord", "github"]);
    await expect(
      as(t, maya).mutation(api.functions.admin.saveCommunityLink, {
        kind: "other",
        label: "Mine",
        url: "https://example.test",
        audience: "everyone",
      }),
    ).rejects.toThrow();
  });
});
