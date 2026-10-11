import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  joinViaInvitation,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { accountForEmail, userWithSignInEmail } from "../functions/lib/signInEmails";
import { isAdmitted } from "../functions/lib/waitlist";
import { MAX_WRONG_TRIES } from "../functions/signInEmails";

/**
 * SEVERAL SIGN-IN EMAILS ON ONE ACCOUNT.
 *
 * An added address is an identifier like the main one, so the properties are
 * about who an address means: nobody can attach an address without the code
 * mailed to it, an address is on at most one account, an attached address
 * reaches its account for sign-in, sharing, invitations and the invite-only
 * gate, and an address whose own account owns something is never taken from
 * it (option C, Dev2 2026-10-09). Only an account that owns nothing is folded
 * in, and its memberships come with it.
 */

const CODE = "246810";

afterEach(() => vi.useRealTimers());

/** Start adding `email`, then plant a known code in place of the mailed one. */
async function start(t: TestConvex, userId: Id<"users">, email: string) {
  const started = await asUser(t, userId).action(api.functions.signInEmails.startAddEmail, { email });
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

async function confirm(t: TestConvex, userId: Id<"users">, code = CODE) {
  return await asUser(t, userId).action(api.functions.signInEmails.confirmAddEmail, { code });
}

async function emails(t: TestConvex, userId: Id<"users">) {
  return await asUser(t, userId).query(api.functions.signInEmails.myEmails, {});
}

async function add(t: TestConvex, userId: Id<"users">, email: string) {
  expect((await start(t, userId, email)).status).toBe("sent");
  return await confirm(t, userId);
}

describe("adding an address", () => {
  test("the right code attaches it; the main address stays where mail goes", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    expect(await add(t, ada, "Ada@Work.example")).toEqual({ status: "added" });
    expect(await emails(t, ada)).toEqual([
      { email: "ada@home.example", mail: true },
      { email: "ada@work.example", mail: false },
    ]);
  });

  test("a wrong code attaches nothing, and enough wrong codes kill the code", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    await start(t, ada, "ada@work.example");
    for (let i = 0; i < MAX_WRONG_TRIES; i++) expect(await confirm(t, ada, "000000")).toEqual({ status: "wrong" });
    expect(await confirm(t, ada)).toEqual({ status: "expired" });
    expect(await emails(t, ada)).toHaveLength(1);
  });

  test("an expired code attaches nothing", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    await start(t, ada, "ada@work.example");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("signInEmailCodes").first();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    expect(await confirm(t, ada)).toEqual({ status: "expired" });
    expect(await emails(t, ada)).toHaveLength(1);
  });

  test("one person's code does not attach for another", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const eve = await createUser(t, "eve@home.example");
    await start(t, ada, "ada@work.example");
    expect(await confirm(t, eve)).toEqual({ status: "expired" });
    expect(await t.run(async (ctx) => await accountForEmail(ctx, "ada@work.example"))).toBeNull();
  });

  test("not an email, already yours, signed out", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    expect((await start(t, ada, "not an email")).status).toBe("invalid_email");
    expect((await start(t, ada, "ADA@home.example")).status).toBe("already_yours");
    expect(
      errorCode(await captureError(() => t.action(api.functions.signInEmails.startAddEmail, { email: "x@y.example" }))),
    ).toBe("NOT_AUTHENTICATED");
  });

  test("sending codes is limited per person and per address", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    for (let i = 0; i < 5; i++) expect((await start(t, ada, `ada${i}@work.example`)).status).toBe("sent");
    expect((await start(t, ada, "ada9@work.example")).status).toBe("too_many");

    const others = await Promise.all([1, 2, 3, 4].map((i) => createUser(t, `p${i}@home.example`)));
    for (let i = 0; i < 3; i++) expect((await start(t, others[i]!, "shared@work.example")).status).toBe("sent");
    expect((await start(t, others[3]!, "shared@work.example")).status).toBe("too_many");
  });
});

describe("an address on another account (option C)", () => {
  test("refused before any code when that account owns a workspace", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const other = await createUser(t, "ada@work.example");
    await createWorkspace(t, other, "adawork", { kind: "personal" });
    expect((await start(t, ada, "ada@work.example")).status).toBe("has_own_workspace");
    expect(await t.run(async (ctx) => await ctx.db.query("signInEmailCodes").collect())).toHaveLength(0);
  });

  test("an account that owns nothing is folded in: memberships move, it closes", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const boss = await createUser(t, "boss@work.example");
    const team = await createWorkspace(t, boss, "workteam", { kind: "shared" });
    const both = await createWorkspace(t, boss, "bothteam", { kind: "shared" });
    const other = await createUser(t, "ada@work.example");
    await addMember(t, team, other, "editor");
    await addMember(t, both, other, "editor");
    await addMember(t, both, ada, "member");

    expect(await add(t, ada, "ada@work.example")).toEqual({ status: "added" });

    const rows = await t.run(async (ctx) =>
      await ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", ada)).collect(),
    );
    expect(rows.find((row) => row.workspaceId === team)?.role).toBe("editor");
    // Both were members of one workspace: one row, the stronger role.
    expect(rows.filter((row) => row.workspaceId === both).map((row) => row.role)).toEqual(["editor"]);
    expect(await t.run(async (ctx) => await ctx.db.get(other))).toBeNull();
    expect(await t.run(async (ctx) => await accountForEmail(ctx, "ada@work.example"))).toBe(ada);
  });

  test("if the other account came to own something after the code was sent, confirming refuses", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const other = await createUser(t, "ada@work.example");
    expect((await start(t, ada, "ada@work.example")).status).toBe("sent");
    await createWorkspace(t, other, "adawork", { kind: "personal" });
    expect(await confirm(t, ada)).toEqual({ status: "has_own_workspace" });
    expect(await t.run(async (ctx) => await ctx.db.get(other))).not.toBeNull();
    expect(await emails(t, ada)).toHaveLength(1);
  });

  test("an address attached to someone else cannot be taken", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const eve = await createUser(t, "eve@home.example");
    await createWorkspace(t, ada, "ada", { kind: "personal" });
    await add(t, ada, "ada@work.example");
    expect((await start(t, eve, "ada@work.example")).status).toBe("has_own_workspace");
  });
});

describe("what an attached address reaches", () => {
  test("sign-in through it finds the account, and the invite-only gate lets it in", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    await add(t, ada, "ada@work.example");
    await t.run(async (ctx) => {
      expect(await userWithSignInEmail(ctx, "ADA@work.example")).toBe(ada);
      expect(await userWithSignInEmail(ctx, "someone@work.example")).toBeNull();
      expect(await isAdmitted(ctx.db, "ada@work.example", { OPEN_SIGNUP: undefined })).toBe(true);
    });
  });

  test("an invitation sent to it reaches the account", async () => {
    const t = setupTest();
    const boss = await createUser(t, "boss@work.example");
    const team = await createWorkspace(t, boss, "workteam", { kind: "shared" });
    const ada = await createUser(t, "ada@home.example");
    await add(t, ada, "ada@work.example");
    await joinViaInvitation(t, { workspaceId: team, owner: boss, invitee: ada, addressedTo: "ada@work.example", role: "member" });
    const rows = await t.run(async (ctx) =>
      await ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", ada)).collect(),
    );
    expect(rows.map((row) => row.workspaceId)).toContain(team);
  });

  test("a removed address reaches nothing and stops signing in", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    await add(t, ada, "ada@work.example");
    await t.run(async (ctx) => {
      await ctx.db.insert("authAccounts", { userId: ada, provider: "email", providerAccountId: "ada@work.example" });
    });
    await asUser(t, ada).mutation(api.functions.signInEmails.removeEmail, { email: "ada@work.example" });
    await t.run(async (ctx) => {
      expect(await accountForEmail(ctx, "ada@work.example")).toBeNull();
      expect(await ctx.db.query("authAccounts").collect()).toHaveLength(0);
    });
  });

  test("nobody can remove or promote an address that is not theirs", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const eve = await createUser(t, "eve@home.example");
    await add(t, ada, "ada@work.example");
    for (const fn of [api.functions.signInEmails.removeEmail, api.functions.signInEmails.setMailEmail]) {
      expect(errorCode(await captureError(() => asUser(t, eve).mutation(fn, { email: "ada@work.example" })))).toBe(
        "NOT_FOUND",
      );
    }
    expect(await t.run(async (ctx) => await accountForEmail(ctx, "ada@work.example"))).toBe(ada);
  });

  test("mail can move to an added address, and the old one stays a sign-in email", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    await add(t, ada, "ada@work.example");
    await asUser(t, ada).mutation(api.functions.signInEmails.setMailEmail, { email: "ada@work.example" });
    expect(await emails(t, ada)).toEqual([
      { email: "ada@work.example", mail: true },
      { email: "ada@home.example", mail: false },
    ]);
    await t.run(async (ctx) => {
      expect(await accountForEmail(ctx, "ada@home.example")).toBe(ada);
      expect(await accountForEmail(ctx, "ada@work.example")).toBe(ada);
    });
  });
});
