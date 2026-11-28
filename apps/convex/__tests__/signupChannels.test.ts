import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { FROM_APP_WINDOW_MS } from "../functions/signupChannels";
import { asUser, createUser, setupTest } from "./fixtures.helpers";

/**
 * SIGN-UP CHANNELS (`functions/signupChannels.ts`): one channel per account, written once, when it is made or in
 * the hour after, and read into `@supa` `data/usage/sign-ups.csv` by `usagePeople.exportRows`. The classifier is
 * `apps/mobile/__tests__/signupChannel.test.ts`; the sheet merge is `apps/mcp/test/dataSyncUsage.test.mjs`.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `fromApp` without the window check: "an account older than an hour is never given a channel" fails.
 * 2. `recordSignupChannel` without the held check: "a channel is written once" fails.
 * 3. `exportRows` dropping the channel: "the export carries each new account's channel" fails.
 */

afterEach(() => {
  vi.useRealTimers();
});

async function channelsOf(t: ReturnType<typeof setupTest>, userId: Id<"users">) {
  return await t.run((ctx) => ctx.db.query("signupChannels").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
}

describe("a sign-up's channel", () => {
  test("the page's first touch names it, and only the channel is kept", async () => {
    const t = setupTest();
    const userId = await createUser(t, "first@example.invalid");
    await asUser(t, userId).mutation(api.functions.signupChannels.fromApp, { touch: { referrer: "https://www.google.com", path: "/" } });
    const rows = await channelsOf(t, userId);
    expect(rows.map((row) => row.channel)).toEqual(["search"]);
    expect(Object.keys(rows[0]).sort()).toEqual(["_creationTime", "_id", "at", "channel", "userId"]);
  });

  test("a channel is written once: a later touch never changes it", async () => {
    const t = setupTest();
    const userId = await createUser(t, "once@example.invalid");
    const me = asUser(t, userId);
    await me.mutation(api.functions.signupChannels.fromApp, { touch: { referrer: "https://t.co" } });
    await me.mutation(api.functions.signupChannels.fromApp, { touch: { referrer: "https://chatgpt.com" } });
    expect((await channelsOf(t, userId)).map((row) => row.channel)).toEqual(["social"]);
  });

  test("an account older than an hour is never given a channel, so accounts from before this stay unknown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const userId = await createUser(t, "old@example.invalid");
    vi.setSystemTime(Date.now() + FROM_APP_WINDOW_MS + 1000);
    await asUser(t, userId).mutation(api.functions.signupChannels.fromApp, { touch: {} });
    expect(await channelsOf(t, userId)).toEqual([]);
  });

  test("signed out, nothing is written", async () => {
    const t = setupTest();
    await t.mutation(api.functions.signupChannels.fromApp, { touch: {} });
    expect(await t.run((ctx) => ctx.db.query("signupChannels").collect())).toEqual([]);
  });

  test("the waitlist row's touch, kept when the address joined, wins over the page that signed in later", async () => {
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "wait@example.invalid", touch: { referrer: "https://chatgpt.com/c/1?q=secret", source: "chatgpt.com", path: "/a" } });
    const row = await t.run((ctx) => ctx.db.query("waitlist").withIndex("by_email", (q) => q.eq("email", "wait@example.invalid")).unique());
    // Cleaned before it is stored: the origin only.
    expect(row?.touch).toEqual({ referrer: "https://chatgpt.com", source: "chatgpt.com", path: "/a" });
    const userId = await createUser(t, "wait@example.invalid");
    await asUser(t, userId).mutation(api.functions.signupChannels.fromApp, { touch: {} });
    expect((await channelsOf(t, userId)).map((r) => r.channel)).toEqual(["ai"]);
  });

  test("what the server knows: a referral waiting for the address is invite, an account set up by texting Tex is tex", async () => {
    const t = setupTest();
    const inviter = await createUser(t, "inviter@example.invalid");
    await t.run((ctx) => ctx.db.insert("referralInvites", { inviterUserId: inviter, email: "friend@example.invalid", token: "t".repeat(32), status: "pending", createdAt: Date.now(), expiresAt: Date.now() + 86_400_000 }));
    const friend = await createUser(t, "friend@example.invalid");
    await t.mutation(internal.functions.signupChannels.atCreation, { userId: friend });
    expect((await channelsOf(t, friend)).map((r) => r.channel)).toEqual(["invite"]);

    const texter = await t.run((ctx) => ctx.db.insert("users", { phone: "+15555550123", phoneVerificationTime: Date.now(), createdAt: Date.now() }));
    await t.mutation(internal.functions.signupChannels.atCreation, { userId: texter, via: "tex" });
    expect((await channelsOf(t, texter)).map((r) => r.channel)).toEqual(["tex"]);
  });

  test("nothing known writes nothing: no guess", async () => {
    const t = setupTest();
    const userId = await createUser(t, "quiet@example.invalid");
    await t.mutation(internal.functions.signupChannels.atCreation, { userId });
    expect(await channelsOf(t, userId)).toEqual([]);
  });

  test("the export carries each new account's channel, and none for an account without one", async () => {
    const t = setupTest();
    const since = Date.now() - 1000;
    const withOne = await createUser(t, "with@example.invalid");
    const without = await createUser(t, "without@example.invalid");
    await asUser(t, withOne).mutation(api.functions.signupChannels.fromApp, { touch: {} });
    const exported = await t.query(internal.functions.usagePeople.exportRows, { since });
    const byUser = new Map(exported.signups.map((row) => [row.userId, row]));
    expect(byUser.get(withOne)?.channel).toBe("direct");
    expect(byUser.get(without)).toBeDefined();
    expect(byUser.get(without)?.channel).toBeUndefined();
  });
});
