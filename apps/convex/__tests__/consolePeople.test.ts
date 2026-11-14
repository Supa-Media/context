import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { cameFromFor, type ConsolePeople } from "../functions/lib/adminFns/consolePeople";
import { JEV_FEATURES } from "../functions/lib/jev/features";
import { utcDay } from "../functions/lib/jev/meter";
import { addMember, asUser, captureError, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * THE PEOPLE PAGE'S ONE LIST (`functions/consolePeople.ts`). Staff only. Each
 * account says how it came in, what it reaches and what it costs; waitlist
 * rows an account already holds are left out; joined invites are left out.
 */

const STAFF = "staff@context.invalid";
const DAY = 86_400_000;
const USD = 1_000_000;

afterEach(() => vi.unstubAllEnvs());

async function everyone(t: TestConvex, by: Id<"users">): Promise<ConsolePeople> {
  return await asUser(t, by).query(api.functions.consolePeople.everyone, {});
}

async function world(t: TestConvex) {
  vi.stubEnv(ADMIN_EMAILS_ENV_VAR, STAFF);
  const staff = await createUser(t, STAFF);
  const kayla = await createUser(t, "kayla@home.example");
  await createWorkspace(t, kayla, "kayla", { kind: "personal" });
  const boss = await createUser(t, "boss@work.example");
  await createWorkspace(t, boss, "boss", { kind: "personal" });
  const team = await createWorkspace(t, boss, "workteam", { kind: "shared" });
  await addMember(t, team, kayla, "member");
  return { staff, kayla, boss, team };
}

const account = (page: ConsolePeople, userId: Id<"users">) => page.accounts.find((row) => row.userId === userId);

async function spend(t: TestConvex, workspaceId: Id<"workspaces">, costUsd: number) {
  await t.run((ctx) =>
    ctx.db.insert("jevUsage", {
      day: utcDay(Date.now()),
      feature: "assistant",
      workspaceId,
      calls: 1,
      failed: 0,
      refused: 0,
      questions: 0,
      tokens: 0,
      costMicroUsd: Math.round(costUsd * USD),
      ms: 0,
      updatedAt: Date.now(),
    }),
  );
}

async function client(t: TestConvex, clientId: string, clientName: string) {
  await t.run((ctx) =>
    ctx.db.insert("oauthClients", { clientId, clientName, redirectUris: [], hashedClientSecret: null, createdAt: 1 }),
  );
}

async function grant(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  clientId: string,
  status: "active" | "revoked",
  lastUsedAt: number,
) {
  await t.run((ctx) =>
    ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId,
      scopes: ["context.read"],
      hashedRefreshToken: `hash-${clientId}-${lastUsedAt}`,
      status,
      lastUsedAt,
      createdAt: 1,
    }),
  );
}

describe("who may see the page", () => {
  test("a non-staff caller is refused", async () => {
    const t = setupTest();
    const { kayla } = await world(t);
    expect(errorCode(await captureError(() => everyone(t, kayla)))).toBe("NOT_FOUND");
  });
});

describe("accounts", () => {
  test("workspaces, active clients (revoked excluded), last seen and spend", async () => {
    const t = setupTest();
    const { staff, kayla } = await world(t);
    await client(t, "claude-desktop", "Claude Desktop");
    await client(t, "old-client", "Old Client");
    const kaylaSpace = await t.run((ctx) =>
      ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", kayla)).first(),
    );
    await grant(t, kaylaSpace!.workspaceId, kayla, "claude-desktop", "active", 1_000);
    await grant(t, kaylaSpace!.workspaceId, kayla, "old-client", "revoked", 5_000);
    await spend(t, kaylaSpace!.workspaceId, 2.5);

    const row = account(await everyone(t, staff), kayla);
    expect(row).toMatchObject({
      handle: "kayla",
      emails: ["kayla@home.example"],
      archived: false,
      lastSeenAt: 5_000,
      clients: [{ name: "Claude Desktop", lastUsedAt: 1_000 }],
      aiUsd: 2.5,
      aiByFeature: [{ label: JEV_FEATURES.assistant.label, usd: 2.5 }],
    });
    expect(row!.workspaces).toEqual(
      expect.arrayContaining([
        { slug: "kayla", kind: "personal", role: "owner" },
        { slug: "workteam", kind: "shared", role: "member" },
      ]),
    );
  });

  test("an account that joined by a referral is from friend, with its inviter", async () => {
    const t = setupTest();
    const { staff, boss } = await world(t);
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("referralInvites", {
        inviterUserId: boss,
        email: "newfriend@home.example",
        token: "tok-friend",
        status: "pending",
        createdAt: now - 60_000,
        expiresAt: now + 14 * DAY,
      }),
    );
    const friend = await createUser(t, "newfriend@home.example");

    const row = account(await everyone(t, staff), friend);
    expect(row).toMatchObject({ from: "friend", invitedBy: "boss" });
  });

  test("an account whose waitlist row has a campaign is from ad, and its row is not listed twice", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    await t.run((ctx) =>
      ctx.db.insert("waitlist", {
        email: "ad@home.example",
        status: "admitted",
        joinedAt: 1,
        source: "homepage",
        campaign: { source: "meta", campaign: "spring" },
        admittedAt: 2,
      }),
    );
    const adUser = await createUser(t, "ad@home.example");

    const page = await everyone(t, staff);
    expect(account(page, adUser)).toMatchObject({ from: "ad", invitedBy: null });
    expect(page.waitlist.some((row) => row.who === "ad@home.example")).toBe(false);
  });

  test("an archived account is returned, flagged archived", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    const old = await createUser(t, "old@test.example");
    await t.run((ctx) => ctx.db.insert("archivedAccounts", { userId: old, archivedBy: staff, archivedAt: 1 }));

    expect(account(await everyone(t, staff), old)).toMatchObject({ archived: true });
  });
});

describe("waitlist", () => {
  test("a phone-only admitted row nobody holds is not told, and a texted one is", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("waitlist", {
        phone: "+14155550123",
        status: "admitted",
        joinedAt: 1,
        source: "login",
        admittedAt: 2,
      });
      await ctx.db.insert("waitlist", {
        phone: "+14155550124",
        status: "admitted",
        joinedAt: 3,
        source: "login",
        admittedAt: 4,
        admittedTextAt: 4,
      });
    });

    const page = await everyone(t, staff);
    expect(page.waitlist.find((row) => row.who === "+14155550123")).toMatchObject({ status: "admitted", told: false, from: "waitlist" });
    expect(page.waitlist.find((row) => row.who === "+14155550124")).toMatchObject({ told: true });
  });
});

describe("invites", () => {
  test("invites that joined are not listed; the rest are, with their status", async () => {
    const t = setupTest();
    const { staff, boss } = await world(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("referralInvites", {
        inviterUserId: boss,
        email: "joiner@home.example",
        token: "tok-joined",
        status: "pending",
        createdAt: now - 60_000,
        expiresAt: now + 14 * DAY,
      });
      await ctx.db.insert("referralInvites", {
        inviterUserId: boss,
        email: "waiting@home.example",
        token: "tok-waiting",
        status: "pending",
        createdAt: now - 1_000,
        expiresAt: now + 14 * DAY,
      });
      await ctx.db.insert("referralInvites", {
        inviterUserId: boss,
        email: "cancelled@home.example",
        token: "tok-cancelled",
        status: "cancelled",
        createdAt: now - 2_000,
        expiresAt: now + 14 * DAY,
        cancelledAt: now - 500,
      });
    });
    await createUser(t, "joiner@home.example");

    const page = await everyone(t, staff);
    expect(page.invites.map((invite) => invite.to).sort()).toEqual(["cancelled@home.example", "waiting@home.example"]);
    expect(page.invites.find((invite) => invite.to === "waiting@home.example")).toMatchObject({
      status: "pending",
      inviterHandle: "boss",
    });
    expect(page.invites.find((invite) => invite.to === "cancelled@home.example")).toMatchObject({ status: "cancelled" });
    expect(page.truncated).toBe(false);
  });
});

describe("cameFromFor", () => {
  async function came(t: TestConvex, id: Id<"users">) {
    return await t.run(async (ctx) => cameFromFor(ctx, (await ctx.db.get(id))!));
  }

  test("an account nobody invited or let in is direct, with no inviter", async () => {
    const t = setupTest();
    const user = await createUser(t, "plain@home.example");
    expect(await came(t, user)).toEqual({ from: "direct", invitedBy: null });
  });

  test("a staff-added waitlist row is staff, and a plain join is waitlist", async () => {
    const t = setupTest();
    await t.run((ctx) =>
      ctx.db.insert("waitlist", { email: "added@home.example", status: "admitted", joinedAt: 1, source: "staff" }),
    );
    await t.run((ctx) =>
      ctx.db.insert("waitlist", { email: "joined@home.example", status: "admitted", joinedAt: 1, source: "homepage" }),
    );
    expect(await came(t, await createUser(t, "added@home.example"))).toEqual({ from: "staff", invitedBy: null });
    expect(await came(t, await createUser(t, "joined@home.example"))).toEqual({ from: "waitlist", invitedBy: null });
  });

  test("an ad row beats a staff or plain row, when an account has several", async () => {
    const t = setupTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("waitlist", { email: "mix@home.example", status: "admitted", joinedAt: 1, source: "homepage" });
      await ctx.db.insert("waitlist", {
        phone: "+14155550199",
        status: "admitted",
        joinedAt: 2,
        source: "login",
        campaign: { medium: "social" },
      });
    });
    const user = await createUser(t, "mix@home.example");
    await t.run((ctx) => ctx.db.patch(user, { phone: "+14155550199", phoneVerificationTime: 1 }));
    expect(await came(t, user)).toEqual({ from: "ad", invitedBy: null });
  });

  test("a joined referral beats an ad row, and names the inviter", async () => {
    const t = setupTest();
    const boss = await createUser(t, "boss@work.example");
    await createWorkspace(t, boss, "boss", { kind: "personal" });
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("referralInvites", {
        inviterUserId: boss,
        email: "both@home.example",
        token: "tok-both",
        status: "pending",
        createdAt: now - 60_000,
        expiresAt: now + 14 * DAY,
      });
      await ctx.db.insert("waitlist", {
        email: "both@home.example",
        status: "admitted",
        joinedAt: 1,
        source: "homepage",
        campaign: { source: "meta" },
      });
    });
    const user = await createUser(t, "both@home.example");
    expect(await came(t, user)).toEqual({ from: "friend", invitedBy: "boss" });
  });
});
