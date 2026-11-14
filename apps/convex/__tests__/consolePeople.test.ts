import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import {
  cameFromFor,
  PAGE_MAX,
  type AccountRow,
  type InviteRow,
  type PeopleUsage,
  type WaitlistRow,
} from "../functions/lib/adminFns/consolePeople";
import { JEV_FEATURES } from "../functions/lib/jev/features";
import { utcDay } from "../functions/lib/jev/meter";
import { addMember, asUser, captureError, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * THE PEOPLE PAGE'S LISTS (`functions/consolePeople.ts`). Staff only. Accounts,
 * waitlist rows and invites come in pages; usage (AI spend, MCP clients) is a
 * separate query, so a grant's `lastUsedAt` never recomputes the lists.
 */

const STAFF = "staff@context.invalid";
const DAY = 86_400_000;
const MINUTE = 60_000;
const USD = 1_000_000;
/** A whole minute, so rounding-down tests read plainly. */
const BASE = Date.UTC(2026, 10, 14, 12, 0);

afterEach(() => vi.unstubAllEnvs());

type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };

/** Every row of a paged query, fetched `numItems` at a time. */
let largestPage = 0;
async function drain<T>(load: (paginationOpts: { numItems: number; cursor: string | null }) => Promise<Page<T>>, numItems = 50): Promise<T[]> {
  const rows: T[] = [];
  largestPage = 0;
  let cursor: string | null = null;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const result = await load({ numItems, cursor });
    rows.push(...result.page);
    largestPage = Math.max(largestPage, result.page.length);
    if (result.isDone) return rows;
    cursor = result.continueCursor;
  }
  throw new Error("pagination did not finish");
}

const accountsOf = (t: TestConvex, by: Id<"users">, numItems?: number) =>
  drain<AccountRow>((paginationOpts) => asUser(t, by).query(api.functions.consolePeople.accountsPage, { paginationOpts }), numItems);
const waitlistOf = (t: TestConvex, by: Id<"users">, numItems?: number) =>
  drain<WaitlistRow>((paginationOpts) => asUser(t, by).query(api.functions.consolePeople.waitlistPage, { paginationOpts }), numItems);
const invitesOf = (t: TestConvex, by: Id<"users">, numItems?: number) =>
  drain<InviteRow>((paginationOpts) => asUser(t, by).query(api.functions.consolePeople.invitesPage, { paginationOpts }), numItems);
async function usageOf(t: TestConvex, by: Id<"users">): Promise<PeopleUsage> {
  return await asUser(t, by).query(api.functions.consolePeople.peopleUsage, {});
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

const rowFor = (rows: AccountRow[], userId: Id<"users">) => rows.find((row) => row.userId === userId);
const waitRow = (rows: WaitlistRow[], who: string) => rows.find((row) => row.who === who);

async function spend(t: TestConvex, workspaceId: Id<"workspaces">, costUsd: number, feature: "assistant" | "ownerSuggest" = "assistant") {
  await t.run((ctx) =>
    ctx.db.insert("jevUsage", {
      day: utcDay(Date.now()),
      feature,
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
  test("a non-staff caller is refused by every list and by usage", async () => {
    const t = setupTest();
    const { kayla } = await world(t);
    const as = asUser(t, kayla);
    const paginationOpts = { numItems: 10, cursor: null };
    for (const call of [
      () => as.query(api.functions.consolePeople.accountsPage, { paginationOpts }),
      () => as.query(api.functions.consolePeople.waitlistPage, { paginationOpts }),
      () => as.query(api.functions.consolePeople.invitesPage, { paginationOpts }),
      () => as.query(api.functions.consolePeople.peopleUsage, {}),
    ]) {
      expect(errorCode(await captureError(call))).toBe("NOT_FOUND");
    }
  });
});

describe("accounts", () => {
  test("identity and workspaces, with no usage fields", async () => {
    const t = setupTest();
    const { staff, kayla } = await world(t);
    const row = rowFor(await accountsOf(t, staff), kayla);
    expect(row).toEqual({
      userId: kayla,
      name: null,
      handle: "kayla",
      emails: ["kayla@home.example"],
      phone: null,
      textingPhones: [],
      joinedAt: expect.any(Number),
      archived: false,
      from: "direct",
      invitedBy: null,
      workspaces: expect.any(Array),
    });
    expect(row!.workspaces).toEqual(
      expect.arrayContaining([
        { slug: "kayla", kind: "personal", role: "owner" },
        { slug: "workteam", kind: "shared", role: "member" },
      ]),
    );
    expect(row).not.toHaveProperty("clients");
    expect(row).not.toHaveProperty("aiUsd");
    expect(row).not.toHaveProperty("lastSeenAt");
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

    expect(rowFor(await accountsOf(t, staff), friend)).toMatchObject({ from: "friend", invitedBy: "boss" });
  });

  test("an account whose waitlist row has a campaign is from ad, and is not hidden from the waitlist", async () => {
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

    const people = await accountsOf(t, staff);
    expect(rowFor(people, adUser)).toMatchObject({ from: "ad", invitedBy: null });
    // Deduping against accounts is the client's job, so the row is still listed here.
    expect(waitRow(await waitlistOf(t, staff), "ad@home.example")).toMatchObject({ from: "ad" });
  });

  test("an archived account is returned, flagged archived", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    const old = await createUser(t, "old@test.example");
    await t.run((ctx) => ctx.db.insert("archivedAccounts", { userId: old, archivedBy: staff, archivedAt: 1 }));

    expect(rowFor(await accountsOf(t, staff), old)).toMatchObject({ archived: true });
  });

  test("accounts come newest first", async () => {
    const t = setupTest();
    const { staff, kayla, boss } = await world(t);
    const ids = (await accountsOf(t, staff)).map((row) => row.userId);
    // Created staff, kayla, boss in that order: newest first is boss, kayla, staff.
    expect(ids).toEqual([boss, kayla, staff]);
  });
});

describe("waitlist", () => {
  test("a phone-only admitted row nobody holds is not told; a texted one is; a row whose phone is held is told", async () => {
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
      await ctx.db.insert("waitlist", {
        phone: "+14155550125",
        status: "admitted",
        joinedAt: 5,
        source: "login",
        admittedAt: 6,
      });
      await ctx.db.insert("users", { phone: "+14155550125", phoneVerificationTime: 1, createdAt: 1 });
    });

    const rows = await waitlistOf(t, staff);
    expect(waitRow(rows, "+14155550123")).toMatchObject({ status: "admitted", told: false, from: "waitlist", email: null, phone: "+14155550123" });
    expect(waitRow(rows, "+14155550124")).toMatchObject({ told: true });
    expect(waitRow(rows, "+14155550125")).toMatchObject({ told: true });
  });

  test("an email row is always told, and a waiting phone row is told (not admitted)", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("waitlist", { email: "mail@home.example", status: "admitted", joinedAt: 1, source: "homepage", admittedAt: 2 });
      await ctx.db.insert("waitlist", { phone: "+14155550126", status: "waiting", joinedAt: 2, source: "login" });
    });
    const rows = await waitlistOf(t, staff);
    expect(waitRow(rows, "mail@home.example")).toMatchObject({ told: true, email: "mail@home.example", phone: null });
    expect(waitRow(rows, "+14155550126")).toMatchObject({ told: true, status: "waiting" });
  });
});

describe("invites", () => {
  test("every invite is listed with its status, joined included, newest first", async () => {
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

    const rows = await invitesOf(t, staff);
    expect(rows.map((row) => row.to)).toEqual(["waiting@home.example", "cancelled@home.example", "joiner@home.example"]);
    expect(rows.find((row) => row.to === "waiting@home.example")).toMatchObject({ status: "pending", inviterHandle: "boss" });
    expect(rows.find((row) => row.to === "cancelled@home.example")).toMatchObject({ status: "cancelled" });
    expect(rows.find((row) => row.to === "joiner@home.example")).toMatchObject({ status: "joined" });
  });
});

describe("usage", () => {
  test("clients exclude revoked ones, lastSeenAt is the newest use of any grant rounded to the minute, and spend splits by feature", async () => {
    const t = setupTest();
    const { staff, kayla } = await world(t);
    await client(t, "claude-desktop", "Claude Desktop");
    await client(t, "old-client", "Old Client");
    const kaylaSpace = await t.run((ctx) =>
      ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", kayla)).first(),
    );
    const space = kaylaSpace!.workspaceId;
    await grant(t, space, kayla, "claude-desktop", "active", BASE + 75_500);
    await grant(t, space, kayla, "old-client", "revoked", BASE + 5 * MINUTE + 59_999);
    await spend(t, space, 2.5, "assistant");
    await spend(t, space, 1, "ownerSuggest");

    const usage = await usageOf(t, staff);
    expect(usage.clients.find((row) => row.userId === kayla)).toEqual({
      userId: kayla,
      lastSeenAt: BASE + 5 * MINUTE,
      clients: [{ name: "Claude Desktop", lastUsedAt: BASE + MINUTE }],
    });
    const spent = usage.spend.find((row) => row.userId === kayla);
    expect(spent).toMatchObject({ aiUsd: 3.5 });
    expect(spent!.aiByFeature).toEqual([
      { label: JEV_FEATURES.assistant.label, usd: 2.5 },
      { label: JEV_FEATURES.ownerSuggest.label, usd: 1 },
    ]);
    expect(usage.truncated).toBe(false);
    expect(usage.invitesOff).toBe(false);
  });

  test("a person whose only grants are revoked has a last seen time and no clients", async () => {
    const t = setupTest();
    const { staff, kayla } = await world(t);
    await client(t, "gone", "Gone Client");
    const space = (await t.run((ctx) =>
      ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", kayla)).first(),
    ))!.workspaceId;
    await grant(t, space, kayla, "gone", "revoked", BASE);

    expect(((await usageOf(t, staff)).clients.find((row) => row.userId === kayla))).toEqual({
      userId: kayla,
      lastSeenAt: BASE,
      clients: [],
    });
  });

  test("a client's name is looked up once however many people hold it", async () => {
    const t = setupTest();
    const { staff, kayla, boss } = await world(t);
    await client(t, "shared-client", "Shared Client");
    const space = (await t.run((ctx) =>
      ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", kayla)).first(),
    ))!.workspaceId;
    await grant(t, space, kayla, "shared-client", "active", BASE);
    await grant(t, space, boss, "shared-client", "active", BASE + MINUTE);

    const usage = await usageOf(t, staff);
    expect(usage.clients.find((row) => row.userId === boss)!.clients).toEqual([{ name: "Shared Client", lastUsedAt: BASE + MINUTE }]);
    expect(usage.clients.find((row) => row.userId === kayla)!.clients).toEqual([{ name: "Shared Client", lastUsedAt: BASE }]);
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

describe("a realistic size", () => {
  test("a capped page stays inside Convex's per-call read limit", () => {
    // An account costs at most ~20 reads (personOf + cameFromFor with a few addresses and workspaces),
    // a waitlist row 2, an invite ~4 (invitesTo + the inviter's handle).
    expect(PAGE_MAX.accounts * 20).toBeLessThan(4_096 / 2);
    expect(PAGE_MAX.waitlist * 2).toBeLessThan(4_096 / 2);
    expect(PAGE_MAX.invites * 4).toBeLessThan(4_096 / 2);
  });

  test("500 accounts and 3,000 waitlist rows page through exactly once each", async () => {
    const t = setupTest();
    vi.stubEnv(ADMIN_EMAILS_ENV_VAR, STAFF);
    const staff = await createUser(t, STAFF);
    const now = Date.now();

    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i += 1) {
        const userId = await ctx.db.insert("users", { email: `person${i}@scale.example`, emailVerificationTime: now, createdAt: now });
        const workspaceId = await ctx.db.insert("workspaces", {
          slug: `person${i}`,
          displayName: `Person ${i}`,
          createdBy: userId,
          kind: "personal",
          structureTemplate: "para",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("workspaceMembers", { workspaceId, userId, role: "owner", joinedAt: now });
      }
      for (let i = 0; i < 3_000; i += 1) {
        const phoneOnly = i % 3 === 0;
        await ctx.db.insert("waitlist", {
          ...(phoneOnly ? { phone: `+1415555${String(i).padStart(4, "0")}` } : { email: `wait${i}@scale.example` }),
          status: i % 5 === 0 ? "admitted" : "waiting",
          joinedAt: now - i,
          source: "homepage",
        });
      }
    });

    // Asking for more than a page may read gets the capped page (Convex allows ~4,096 reads a call).
    const people = await accountsOf(t, staff, 1_000);
    expect(largestPage).toBe(PAGE_MAX.accounts);
    expect(people).toHaveLength(501);
    expect(new Set(people.map((row) => row.userId)).size).toBe(501);
    // Every scale account has its personal workspace as handle; the staff account has none.
    const scale = people.filter((row) => row.userId !== staff);
    expect(scale.every((row) => row.workspaces.length === 1 && row.handle !== null)).toBe(true);

    const waiting = await waitlistOf(t, staff, 1_000);
    expect(largestPage).toBe(PAGE_MAX.waitlist);
    expect(waiting).toHaveLength(3_000);
    expect(new Set(waiting.map((row) => row.id)).size).toBe(3_000);
  }, 60_000);
});
