/**
 * THE CENSUS'S WAITLIST SLICE — `functions/lib/adminFns/censusWaitlist.ts`,
 * read by `admin.censusReport`.
 *
 * Dev2 (2026-10-07): people let in from the waitlist did not show on the
 * Accounts roster, and there was no way to read the funnel for them alone.
 * Letting somebody in writes a waitlist row, not an account, so these pin the
 * join: who counts as "from the waitlist", who is let in but has not signed
 * up yet, and that the waitlist funnel is not the everyone funnel.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *
 *   matching addresses without normalizing case                       1
 *   reading waiting rows instead of admitted ones                     3
 *   listing an account that signed up as "not signed up"             1
 */

import { afterEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";

const ADMIN = "staff@example.test";
const DAY = 86_400_000;

type Harness = ReturnType<typeof convexTest>;

afterEach(() => {
  delete process.env[ADMIN_EMAILS_ENV_VAR];
});

async function seedUser(t: Harness, email: string): Promise<Id<"users">> {
  return await t.run(
    async (ctx) => await ctx.db.insert("users", { email, emailVerificationTime: Date.now() } as never),
  );
}

async function seedOwnedWorkspace(t: Harness, owner: Id<"users">, slug: string): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      slug,
      displayName: slug,
      createdBy: owner,
      kind: "personal",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", { workspaceId, userId: owner, role: "owner", joinedAt: now });
  });
}

async function seedRow(
  t: Harness,
  email: string,
  status: "waiting" | "admitted" | "removed",
  admittedDaysAgo = 1,
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("waitlist", {
      email,
      status,
      joinedAt: now - 10 * DAY,
      source: "homepage",
      ...(status === "admitted" ? { admittedAt: now - admittedDaysAgo * DAY } : {}),
    });
  });
}

async function report(t: Harness) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const staffId = await seedUser(t, ADMIN);
  return await t.withIdentity({ subject: staffId }).query(api.functions.admin.censusReport, { days: 30 });
}

describe("the census's waitlist slice", () => {
  test("marks accounts let in from the waitlist, matching the address in any case", async () => {
    const t = convexTest(schema, modules);
    const ada = await seedUser(t, "Ada@Example.test");
    await seedOwnedWorkspace(t, ada, "ada");
    await seedUser(t, "invited@example.test");
    await seedRow(t, "ada@example.test", "admitted", 2);

    const census = await report(t);
    const byEmail = new Map(census.roster.map((row) => [row.email, row]));
    expect(byEmail.get("Ada@Example.test")?.letInAt).toBeGreaterThan(0);
    expect(byEmail.get("invited@example.test")?.letInAt).toBeNull();
    expect(byEmail.get(ADMIN)?.letInAt).toBeNull();
  });

  test("lists who was let in but has not signed up yet, newest first", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "ada@example.test");
    await seedRow(t, "ada@example.test", "admitted", 1);
    await seedRow(t, "older@example.test", "admitted", 5);
    await seedRow(t, "newer@example.test", "admitted", 1);
    await seedRow(t, "waiting@example.test", "waiting");
    await seedRow(t, "removed@example.test", "removed");

    const { waitlist } = await report(t);
    expect(waitlist.letIn).toEqual({ count: 3, isFloor: false });
    expect(waitlist.signedUp).toBe(1);
    expect(waitlist.notSignedUp.map((row) => row.email)).toEqual([
      "newer@example.test",
      "older@example.test",
    ]);
    expect(waitlist.notSignedUpTotal).toBe(2);
  });

  test("the waitlist funnel counts only waitlist accounts, and starts at let in", async () => {
    const t = convexTest(schema, modules);
    const ada = await seedUser(t, "ada@example.test");
    await seedOwnedWorkspace(t, ada, "ada");
    await seedUser(t, "grace@example.test");
    const other = await seedUser(t, "other@example.test");
    await seedOwnedWorkspace(t, other, "other");
    await seedRow(t, "ada@example.test", "admitted");
    await seedRow(t, "grace@example.test", "admitted");
    await seedRow(t, "pending@example.test", "admitted");

    const census = await report(t);
    const steps = Object.fromEntries(census.waitlist.funnel.map((row) => [row.step, row.count]));
    expect(census.waitlist.funnel[0].step).toBe("let-in");
    expect(steps).toMatchObject({ "let-in": 3, "signed-up": 2, "made-a-context": 1, paying: 0 });
    // The everyone funnel still counts everybody, staff included.
    expect(census.funnel[0]).toEqual({ step: "signed-up", count: 4 });
  });

  test("a stranger cannot read it", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const stranger = await seedUser(t, "stranger@example.test");
    await seedRow(t, "someone@example.test", "admitted");
    await expect(
      t.withIdentity({ subject: stranger }).query(api.functions.admin.censusReport, {}),
    ).rejects.toThrow();
  });
});
