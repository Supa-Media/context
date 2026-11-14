/**
 * The census's growth slice for the staff console's Growth and Home pages: the growth funnel, Tex access and the
 * mail inboxes open to anyone. Split from census.test.ts to keep that file under the review threshold.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { withSession } from "./session.helpers";

const ADMIN = "staff@example.test";

/** A fixed clock, so a test never straddles a UTC midnight and flakes. */
const NOON = Date.parse("2026-09-14T12:00:00.000Z");

type Harness = ReturnType<typeof convexTest>;

async function seedUser(t: Harness, email: string): Promise<Id<"users">> {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("users", {
        email,
        emailVerificationTime: Date.now(),
      } as never),
  );
}

async function seedContext(
  t: Harness,
  owner: Id<"users">,
  slug: string,
  kind: "personal" | "shared",
  createdAt: number = NOON,
): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug,
      displayName: slug,
      createdBy: owner,
      kind,
      structureTemplate: "para",
      createdAt,
      updatedAt: createdAt,
    });
    await ctx.db.insert("workspaceMembers", {
      workspaceId,
      userId: owner,
      role: "owner",
      joinedAt: createdAt,
    });
    return workspaceId;
  });
}

async function grant(
  t: Harness,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  clientId: string,
  status: "active" | "revoked" = "active",
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId,
      scopes: ["context:read"],
      hashedRefreshToken: `hash-${clientId}-${String(workspaceId)}-${status}`,
      status,
      lastUsedAt: NOON,
      createdAt: NOON,
    });
  });
}

async function staff(t: Harness) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const userId = await seedUser(t, ADMIN);
  return { userId, as: withSession(t, userId) };
}

describe("the census's growth slice", () => {
  test("the growth funnel counts texting, a client and a shared workspace, each on its own", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await staff(t);
    const member = await seedUser(t, "member@example.test");
    const texter = await seedUser(t, "texter@example.test");
    const team = await seedContext(t, userId, "team", "shared");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceMembers", { workspaceId: team, userId: member, role: "member", joinedAt: NOON });
      await ctx.db.insert("phoneLinks", { userId: texter, phone: "+15555550177", linkedAt: NOON });
    });
    await grant(t, team, member, "cid-growth");
    // A client on a personal workspace only: connected, but not in a shared one.
    const solo = await seedUser(t, "solo@example.test");
    const mine = await seedContext(t, solo, "solo-notes", "personal");
    await grant(t, mine, solo, "cid-growth");

    const report = await as.query(api.functions.admin.censusReport, {});
    expect(report.growthFunnel).toEqual([
      { step: "signed-up", count: 4 },
      { step: "texted-tex", count: 1 },
      // The member and the solo account; a client is not a shared workspace.
      { step: "connected-a-client", count: 2 },
      // The owner of the shared workspace and its member; the texter is not in it.
      { step: "in-a-shared-workspace", count: 2 },
    ]);
  });

  test("a personal workspace is not a shared one for the growth funnel", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await staff(t);
    await seedContext(t, userId, "mine", "personal");

    const report = await as.query(api.functions.admin.censusReport, {});
    expect(report.growthFunnel.find((row) => row.step === "in-a-shared-workspace")).toEqual({
      step: "in-a-shared-workspace",
      count: 0,
    });
  });

  test("who may text Tex: a texting link is canText, a verified sign-in phone with none is phoneButOff", async () => {
    const t = convexTest(schema, modules);
    const { as } = await staff(t);
    const texter = await seedUser(t, "texter@example.test");
    const signsIn = await seedUser(t, "signs-in@example.test");
    const unverified = await seedUser(t, "unverified@example.test");
    const linkedAndSignsIn = await seedUser(t, "both@example.test");
    await t.run(async (ctx) => {
      await ctx.db.patch(texter, { phone: "+15555550101", phoneVerificationTime: 1 });
      await ctx.db.insert("phoneLinks", { userId: texter, phone: "+15555550101", linkedAt: 1 });
      await ctx.db.patch(signsIn, { phone: "+15555550102", phoneVerificationTime: 1 });
      await ctx.db.patch(unverified, { phone: "+15555550103" });
      await ctx.db.patch(linkedAndSignsIn, { phone: "+15555550104", phoneVerificationTime: 1 });
      await ctx.db.insert("phoneLinks", { userId: linkedAndSignsIn, phone: "+15555550104", linkedAt: 1 });
    });

    const report = await as.query(api.functions.admin.censusReport, {});
    expect(report.texAccess).toEqual({ canText: 2, phoneButOff: 1 });
    expect(report.growthFunnel.find((row) => row.step === "texted-tex")?.count).toBe(2);
  });

  test("mail that accepts anyone names its workspaces by slug, sorted, at most twenty", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await staff(t);
    const open = async (slug: string, allowAnySender: boolean) => {
      const workspaceId = await seedContext(t, userId, slug, "personal");
      await t.run(async (ctx) => {
        await ctx.db.insert("ingestionSettings", {
          workspaceId,
          targetFolder: "0-inbox/",
          allowedSenders: [],
          allowedDomains: [],
          allowAnySender,
          updatedBy: userId,
          createdAt: NOON,
          updatedAt: NOON,
        });
      });
    };
    await open("zeta", true);
    await open("closed", false);
    await open("alpha", true);
    for (let i = 0; i < 20; i += 1) await open(`w${String(i).padStart(2, "0")}`, true);

    const report = await as.query(api.functions.admin.censusReport, {});
    expect(report.sources.mailOpen).toBe(22);
    expect(report.sources.mailOpenSlugs).toHaveLength(20);
    expect(report.sources.mailOpenSlugs.slice(0, 3)).toEqual(["alpha", "w00", "w01"]);
    expect(report.sources.mailOpenSlugs).not.toContain("closed");
    expect([...report.sources.mailOpenSlugs]).toEqual([...report.sources.mailOpenSlugs].sort());
    // Home's "Needs you" reads the same list from its own light query.
    expect(await as.query(api.functions.consoleHome.openMail, {})).toEqual(report.sources.mailOpenSlugs);
  });

  test("Home's open-mail list refuses everyone who is not staff", async () => {
    const t = convexTest(schema, modules);
    const outsider = await seedUser(t, "someone@example.test");
    await expect(withSession(t, outsider).query(api.functions.consoleHome.openMail, {})).rejects.toThrow();
    await expect(t.query(api.functions.consoleHome.openMail, {})).rejects.toThrow();
  });
});
