import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { asUser, captureError, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * THE PEOPLE TAB (Dev2, 2026-10-09): staff look somebody up by any of their
 * names, addresses or phones, see every address, their username and the
 * workspaces they reach, and type in their phone. Nobody else can do either;
 * one phone stays one person; and the trail keeps four digits, not numbers.
 */

const STAFF = "staff@supa.media";

afterEach(() => vi.unstubAllEnvs());

async function world(t: TestConvex) {
  vi.stubEnv(ADMIN_EMAILS_ENV_VAR, STAFF);
  const staff = await createUser(t, STAFF);
  const kayla = await createUser(t, "kayla@home.example");
  await createWorkspace(t, kayla, "kayla", { kind: "personal" });
  await t.run(async (ctx) => {
    await ctx.db.insert("names", { name: "kayla", kind: "user", userId: kayla, claimedBy: kayla, claimedAt: 1 });
    await ctx.db.insert("signInEmails", { userId: kayla, email: "kayla@work.example", addedAt: 1 });
  });
  const boss = await createUser(t, "boss@work.example");
  const team = await createWorkspace(t, boss, "workteam", { kind: "shared" });
  await t.run((ctx) =>
    ctx.db.insert("workspaceMembers", { workspaceId: team, userId: kayla, role: "member", joinedAt: 1 }),
  );
  return { staff, kayla, boss };
}

const find = (t: TestConvex, by: Id<"users">, search: string) =>
  asUser(t, by).query(api.functions.admin.listPeople, { search });

const setPhone = (t: TestConvex, by: Id<"users">, userId: Id<"users">, phone: string | null) =>
  asUser(t, by).mutation(api.functions.admin.setPersonPhone, { userId, phone });

describe("looking somebody up", () => {
  test("by an added address, the username or the name: everything about them", async () => {
    const t = setupTest();
    const { staff, kayla } = await world(t);
    for (const search of ["work.example", "@kay", "KAYLA@HOME"]) {
      const people = await find(t, staff, search);
      expect(people.map((person) => person.userId)).toContain(kayla);
    }
    const [person] = await find(t, staff, "@kayla");
    expect(person).toMatchObject({
      userId: kayla,
      username: "kayla",
      emails: ["kayla@home.example", "kayla@work.example"],
      phone: null,
    });
    expect(person!.workspaces).toEqual(
      expect.arrayContaining([
        { slug: "kayla", name: "kayla", kind: "personal", role: "owner" },
        { slug: "workteam", name: "workteam", kind: "shared", role: "member" },
      ]),
    );
  });

  test("by phone, typed any way, including a phone linked for texting", async () => {
    const t = setupTest();
    const { staff, kayla, boss } = await world(t);
    await setPhone(t, staff, kayla, "+1 (415) 555-0100");
    await t.run((ctx) => ctx.db.insert("phoneLinks", { userId: boss, phone: "+14155550199", linkedAt: 1 }));
    expect((await find(t, staff, "555-0100")).map((person) => person.userId)).toEqual([kayla]);
    const texting = await find(t, staff, "0199");
    expect(texting.map((person) => person.userId)).toEqual([boss]);
    expect(texting[0]!.textingPhones).toEqual(["+14155550199"]);
  });

  test("an empty search lists the newest accounts", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    expect((await find(t, staff, "")).length).toBe(3);
  });
});

describe("typing in a phone", () => {
  test("saved as confirmed, so the phone check is passed", async () => {
    const t = setupTest();
    const { staff, kayla } = await world(t);
    expect(await setPhone(t, staff, kayla, "+44 20 7946 0000")).toEqual({ status: "saved", phone: "+442079460000" });
    const user = await t.run(async (ctx) => await ctx.db.get(kayla));
    expect(user?.phone).toBe("+442079460000");
    expect(user?.phoneVerificationTime).toBeTypeOf("number");
    expect(await asUser(t, kayla).query(api.functions.phoneCheck.myPhoneCheck, {})).toMatchObject({ confirmed: true });
  });

  test("a number without a country code is refused, not guessed", async () => {
    const t = setupTest();
    const { staff, kayla } = await world(t);
    expect(await setPhone(t, staff, kayla, "555 0100")).toEqual({ status: "invalid" });
  });

  test("a number somebody else holds is refused, saying who", async () => {
    const t = setupTest();
    const { staff, kayla, boss } = await world(t);
    await setPhone(t, staff, boss, "+14155550100");
    expect(await setPhone(t, staff, kayla, "+14155550100")).toEqual({
      status: "taken",
      phone: "+14155550100",
      heldBy: "boss@work.example",
    });
    await t.run((ctx) => ctx.db.insert("phoneLinks", { userId: boss, phone: "+14155550111", linkedAt: 1 }));
    expect((await setPhone(t, staff, kayla, "+14155550111")).status).toBe("taken");
    expect((await t.run(async (ctx) => await ctx.db.get(kayla)))?.phone).toBeUndefined();
  });

  test("changing and removing it; the trail keeps four digits", async () => {
    const t = setupTest();
    const { staff, kayla } = await world(t);
    await setPhone(t, staff, kayla, "+14155550100");
    await setPhone(t, staff, kayla, "+14155550123");
    expect(await setPhone(t, staff, kayla, null)).toEqual({ status: "removed" });
    const user = await t.run(async (ctx) => await ctx.db.get(kayla));
    expect(user?.phone).toBeUndefined();
    expect(user?.phoneVerificationTime).toBeUndefined();
    const trail = await t.run(async (ctx) => await ctx.db.query("adminAuditEvents").collect());
    expect(trail.map((row) => [row.action, row.details])).toEqual([
      ["person.phone_set", { phone: "0100", was: null }],
      ["person.phone_set", { phone: "0123", was: "0100" }],
      ["person.phone_removed", { was: "0123" }],
    ]);
    expect(JSON.stringify(trail)).not.toContain("4155550");
  });
});

const archive = (t: TestConvex, by: Id<"users">, userId: Id<"users">, archived = true) =>
  asUser(t, by).mutation(api.functions.admin.setPersonArchived, { userId, archived });

describe("archiving", () => {
  test("hides an account from People and the Growth figures, deletes nothing, and comes back", async () => {
    const t = setupTest();
    const { staff, kayla, boss } = await world(t);
    const before = await asUser(t, staff).query(api.functions.admin.censusReport, {});
    expect(await archive(t, staff, boss)).toEqual({ status: "archived" });

    expect((await find(t, staff, "")).map((person) => person.userId)).not.toContain(boss);
    expect(await find(t, staff, "boss@work")).toEqual([]);
    const archived = await asUser(t, staff).query(api.functions.admin.listPeople, { search: "", archived: true });
    expect(archived.map((person) => [person.userId, person.archived])).toEqual([[boss, true]]);

    const after = await asUser(t, staff).query(api.functions.admin.censusReport, {});
    expect(after.accounts.total.count).toBe(before.accounts.total.count - 1);
    // boss made the shared workspace; kayla's personal one still counts.
    expect(after.contexts.total.count).toBe(before.contexts.total.count - 1);
    expect(after.roster.map((row) => row.email)).not.toContain("boss@work.example");

    await t.run(async (ctx) => {
      expect(await ctx.db.get(boss)).not.toBeNull();
      expect(await ctx.db.query("workspaces").collect()).toHaveLength(2);
    });

    expect(await archive(t, staff, boss, false)).toEqual({ status: "unarchived" });
    expect((await find(t, staff, "boss@work")).map((person) => person.userId)).toEqual([boss]);
    const trail = await t.run(async (ctx) => await ctx.db.query("adminAuditEvents").collect());
    expect(trail.map((row) => row.action)).toEqual(["person.archived", "person.unarchived"]);
    void kayla;
  });

  test("staff cannot archive themselves, and nobody else can archive at all", async () => {
    const t = setupTest();
    const { staff, kayla, boss } = await world(t);
    expect(await archive(t, staff, staff)).toEqual({ status: "self" });
    expect(await captureError(() => archive(t, kayla, boss))).toBeDefined();
    expect(await t.run(async (ctx) => await ctx.db.query("archivedAccounts").collect())).toEqual([]);
  });
});

describe("nobody else", () => {
  test("can look people up or set a phone", async () => {
    const t = setupTest();
    const { kayla, boss } = await world(t);
    expect(errorCode(await captureError(() => find(t, kayla, "")))).toBeDefined();
    expect(await captureError(() => setPhone(t, kayla, boss, "+14155550100"))).toBeDefined();
    expect((await t.run(async (ctx) => await ctx.db.get(boss)))?.phone).toBeUndefined();
  });
});
