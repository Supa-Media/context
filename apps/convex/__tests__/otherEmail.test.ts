import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";
import { deletePersonalRows } from "../functions/lib/account/personalRows";
import { accountForEmail } from "../functions/lib/signInEmails";
import { HAND_OFF_TTL_MS } from "../functions/otherEmail";

/**
 * "DO YOU ALREADY USE CONTEXT WITH ANOTHER EMAIL?" (board s7).
 *
 * A first sign-in with a work address makes an account that owns nothing.
 * Answering yes hands that address to the account the person already has:
 * the new account mints a token, the app signs in with the other address the
 * ordinary way, and that account spends the token. The properties: only an
 * account that owns nothing is asked or can hand off, a token is spent once
 * and expires, everything is re-checked when it is spent, and afterwards the
 * work address signs in to the old account with no second account left.
 */

const ORIGIN = "https://context.test";

const question = (t: TestConvex, userId: Id<"users">) =>
  asUser(t, userId).query(api.functions.otherEmail.myOtherEmailQuestion, {});

async function mint(t: TestConvex, userId: Id<"users">): Promise<string> {
  const started = await asUser(t, userId).action(api.functions.otherEmail.startHandOff, {});
  expect(started.status).toBe("ok");
  return started.token!;
}

const finish = (t: TestConvex, userId: Id<"users">, token: string) =>
  asUser(t, userId).mutation(api.functions.otherEmail.finishHandOff, { token });

async function veteran(t: TestConvex) {
  const old = await createUser(t, "kayla@home.example");
  await createWorkspace(t, old, "kayla", { kind: "personal" });
  return old;
}

describe("who is asked", () => {
  test("a new account that owns nothing is asked once; no is answered for good", async () => {
    const t = setupTest();
    const fresh = await createUser(t, "kayla@work.example");
    expect(await question(t, fresh)).toEqual({ ask: true, email: "kayla@work.example" });
    await asUser(t, fresh).mutation(api.functions.messages.markMessageSeen, { message: "other-email" });
    expect(await question(t, fresh)).toEqual({ ask: false, email: "kayla@work.example" });
  });

  test("an account that owns a workspace is never asked and cannot hand off", async () => {
    const t = setupTest();
    const old = await veteran(t);
    expect((await question(t, old)).ask).toBe(false);
    expect(await asUser(t, old).action(api.functions.otherEmail.startHandOff, {})).toEqual({
      status: "not_needed",
    });
  });

  test("an account whose address was never confirmed is not asked", async () => {
    const t = setupTest();
    const unconfirmed = await t.run((ctx) => ctx.db.insert("users", { email: "x@work.example" }));
    expect((await question(t, unconfirmed)).ask).toBe(false);
  });
});

describe("handing the address over", () => {
  test("yes: memberships move, the address signs in to the old account, the new one closes", async () => {
    const t = setupTest();
    const boss = await createUser(t, "boss@work.example");
    const team = await createWorkspace(t, boss, "workteam", { kind: "shared" });
    const fresh = await createUser(t, "kayla@work.example");
    await addMember(t, team, fresh, "member");
    const old = await veteran(t);

    expect(await finish(t, old, await mint(t, fresh))).toEqual({ status: "added", email: "kayla@work.example" });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(fresh)).toBeNull();
      expect(await accountForEmail(ctx, "kayla@work.example")).toBe(old);
      const rows = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_user", (q) => q.eq("userId", old))
        .collect();
      expect(rows.map((row) => row.workspaceId)).toContain(team);
    });
    expect(await asUser(t, old).query(api.functions.signInEmails.myEmails, {})).toEqual([
      { email: "kayla@home.example", mail: true },
      { email: "kayla@work.example", mail: false },
    ]);
  });

  test("a token is spent once", async () => {
    const t = setupTest();
    const fresh = await createUser(t, "kayla@work.example");
    const old = await veteran(t);
    const token = await mint(t, fresh);
    expect((await finish(t, old, token)).status).toBe("added");
    const eve = await createUser(t, "eve@home.example");
    expect(await finish(t, eve, token)).toEqual({ status: "expired" });
  });

  test("an expired token hands nothing over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const fresh = await createUser(t, "kayla@work.example");
    const old = await veteran(t);
    const token = await mint(t, fresh);
    vi.setSystemTime(Date.now() + HAND_OFF_TTL_MS + 1);
    expect(await finish(t, old, token)).toEqual({ status: "expired" });
    expect(await t.run(async (ctx) => await ctx.db.get(fresh))).not.toBeNull();
  });

  test("a made-up token hands nothing over", async () => {
    const t = setupTest();
    const fresh = await createUser(t, "kayla@work.example");
    const old = await veteran(t);
    await mint(t, fresh);
    expect(await finish(t, old, "0".repeat(64))).toEqual({ status: "expired" });
    expect(await t.run(async (ctx) => await ctx.db.get(fresh))).not.toBeNull();
  });

  test("a newer token replaces an older one", async () => {
    const t = setupTest();
    const fresh = await createUser(t, "kayla@work.example");
    const old = await veteran(t);
    const first = await mint(t, fresh);
    const second = await mint(t, fresh);
    expect(await finish(t, old, first)).toEqual({ status: "expired" });
    expect((await finish(t, old, second)).status).toBe("added");
  });

  test("signing in with the same address again keeps the token for the right one", async () => {
    const t = setupTest();
    const fresh = await createUser(t, "kayla@work.example");
    const token = await mint(t, fresh);
    expect(await finish(t, fresh, token)).toEqual({ status: "same_account" });
    const old = await veteran(t);
    expect((await finish(t, old, token)).status).toBe("added");
  });

  test("if the new account came to own something after saying yes, nothing moves", async () => {
    const t = setupTest();
    const fresh = await createUser(t, "kayla@work.example");
    const old = await veteran(t);
    const token = await mint(t, fresh);
    await createWorkspace(t, fresh, "kaylawork", { kind: "personal" });
    expect(await finish(t, old, token)).toEqual({ status: "has_own_workspace" });
    expect(await t.run(async (ctx) => await ctx.db.get(fresh))).not.toBeNull();
    expect(await t.run(async (ctx) => await accountForEmail(ctx, "kayla@work.example"))).toBe(fresh);
  });

  test("signed out, nothing is minted or spent", async () => {
    const t = setupTest();
    await expect(t.action(api.functions.otherEmail.startHandOff, {})).rejects.toThrow();
    await expect(t.mutation(api.functions.otherEmail.finishHandOff, { token: "x" })).rejects.toThrow();
  });
});

describe("closing an account with added addresses", () => {
  test("frees each address and clears what waits on them", async () => {
    const t = setupTest();
    const fresh = await createUser(t, "kayla@work.example");
    const old = await veteran(t);
    await finish(t, old, await mint(t, fresh));
    await t.run(async (ctx) => {
      await deletePersonalRows(ctx, old);
      expect(await accountForEmail(ctx, "kayla@work.example")).toBeNull();
      expect(await ctx.db.query("signInEmails").collect()).toHaveLength(0);
      expect(await ctx.db.query("emailHandOffs").collect()).toHaveLength(0);
    });
  });
});

describe("through the real sign-in", () => {
  let codes: Map<string, string>;

  beforeEach(async () => {
    vi.stubEnv("RESEND_API_KEY", "re_fake_key_for_tests");
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("CONVEX_SITE_URL", ORIGIN);
    vi.stubEnv("OPEN_SIGNUP", "true");
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    vi.stubEnv("JWT_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    codes = new Map();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== "https://api.resend.com/emails") throw new Error(`network access attempted: ${url}`);
      const mail = JSON.parse(String(init?.body ?? "{}")) as { to: string | string[]; subject?: string };
      const code = /^(\d{6}) is your Context code$/.exec(mail.subject ?? "")?.[1];
      if (code !== undefined) codes.set(Array.isArray(mail.to) ? mail.to[0]! : mail.to, code);
      return new Response(JSON.stringify({ id: "fake" }), { status: 200 });
    });
  });

  async function signIn(t: TestConvex, email: string): Promise<Id<"users">> {
    await t.action(api.auth.signIn, { provider: "email", params: { email } });
    await t.action(api.auth.signIn, { provider: "email", params: { email, code: codes.get(email)! } });
    await drainScheduled(t);
    const user = await t.run(async (ctx) => await accountForEmail(ctx, email));
    expect(user).not.toBeNull();
    return user!;
  }

  test("work email first, yes, then the old email: one account with both", async () => {
    const t = setupTest();
    const old = await veteran(t);
    const fresh = await signIn(t, "kayla@work.example");
    expect(fresh).not.toBe(old);
    expect((await question(t, fresh)).ask).toBe(true);

    const token = await mint(t, fresh);
    expect(await signIn(t, "kayla@home.example")).toBe(old);
    expect((await finish(t, old, token)).status).toBe("added");

    expect(await signIn(t, "kayla@work.example")).toBe(old);
    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users.map((user) => user._id)).toEqual([old]);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
