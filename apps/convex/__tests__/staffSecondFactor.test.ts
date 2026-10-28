/**
 * The staff console's second factor (`functions/staffSecondFactor.ts`,
 * `lib/staffFactor.ts`): an authenticator code per session on top of the
 * email code, with a rollout that cannot lock out the person enrolling.
 *
 * Sabotage (temporary local edits, reverted): `requireAdmin` skipping the
 * standing check fails "an enrolled account's new session owes a code"; the
 * `step <= lastUsedStep` comparison removed fails "a code is taken once";
 * the started-by-session comparison removed from `myStaffFactor` fails "only
 * the session that started enrolling is shown the key"; the wrong-tries cap
 * removed fails "five wrong codes make the account wait"; deleting the
 * confirmed key on restart fails "the current key stays in force until the
 * new one is confirmed".
 */

import { afterEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { STAFF_SECOND_FACTOR_ENV_VAR, staffFactorKey } from "../functions/lib/staffFactor";
import { base32Decode, matchTotp, totpCode, totpStep } from "../functions/lib/totp";
import { withSession } from "./session.helpers";

const ADMIN = "staff@supa.media";

afterEach(() => {
  delete process.env[ADMIN_EMAILS_ENV_VAR];
  delete process.env[STAFF_SECOND_FACTOR_ENV_VAR];
});

async function staff() {
  const t = convexTest(schema, modules);
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const userId = await t.run(
    async (ctx) => await ctx.db.insert("users", { email: ADMIN, emailVerificationTime: Date.now() } as never),
  );
  return { t, userId: userId as Id<"users">, session: withSession(t, userId) };
}

async function currentCode(t: Awaited<ReturnType<typeof staff>>["t"], userId: Id<"users">, offsetSteps = 0) {
  const row = await t.run(async (ctx) =>
    await ctx.db.query("staffSecondFactors").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
  );
  const key = await staffFactorKey(userId, row!.nonce);
  return await totpCode(key!, totpStep(Date.now()) + offsetSteps);
}

async function enrolled() {
  const scenario = await staff();
  await scenario.session.mutation(api.functions.staffSecondFactor.startEnrollment, {});
  const code = await currentCode(scenario.t, scenario.userId);
  expect(await scenario.session.mutation(api.functions.staffSecondFactor.submitCode, { code })).toEqual({ ok: true });
  return scenario;
}

describe("codes", () => {
  test("RFC 6238's SHA-1 vectors, read as six digits", async () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    expect(await totpCode(secret, totpStep(59_000))).toBe("287082");
    expect(await totpCode(secret, totpStep(1_111_111_109_000))).toBe("081804");
    expect(await totpCode(secret, totpStep(20_000_000_000_000))).toBe("353130");
    expect(await matchTotp(secret, "287082", 59_000)).toBe(1);
    expect(await matchTotp(secret, "28708", 59_000)).toBeNull();
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")).toEqual(secret);
  });
});

describe("rollout", () => {
  test("staff who have not enrolled keep working until the deployment requires a key", async () => {
    const { session } = await staff();
    expect(await session.query(api.functions.admin.amIAdmin, {})).toBe(true);
    expect(await session.query(api.functions.staffSecondFactor.myStaffFactor, {})).toMatchObject({
      staff: true,
      enrolled: false,
      standing: "open",
    });
    process.env[STAFF_SECOND_FACTOR_ENV_VAR] = "required";
    expect(await session.query(api.functions.admin.amIAdmin, {})).toBe(false);
    await expect(session.query(api.functions.admin.usageReport, {})).rejects.toThrow();
    expect(await session.query(api.functions.staffSecondFactor.myStaffFactor, {})).toMatchObject({ standing: "enroll" });
  });

  test("enrolling is open on the first factor alone, and confirming it opens this session", async () => {
    process.env[STAFF_SECOND_FACTOR_ENV_VAR] = "required";
    const { t, userId, session } = await enrolled();
    expect(await session.query(api.functions.admin.amIAdmin, {})).toBe(true);
    const census = await t.query(internal.functions.staffSecondFactor.census, {});
    expect(census).toEqual({ allowlisted: 1, accounts: 1, enrolled: 1, required: true });
    expect(userId).toBeTruthy();
  });

  test("an enrolled account's new session owes a code, whatever the deployment says", async () => {
    const { t, userId } = await enrolled();
    const laptop = withSession(t, userId);
    expect(await laptop.query(api.functions.admin.amIAdmin, {})).toBe(false);
    expect(await laptop.query(api.functions.staffSecondFactor.myStaffFactor, {})).toMatchObject({ standing: "step_up" });
    const code = await currentCode(t, userId, 1);
    expect(await laptop.mutation(api.functions.staffSecondFactor.submitCode, { code })).toEqual({ ok: true });
    expect(await laptop.query(api.functions.admin.amIAdmin, {})).toBe(true);
  });

  test("signing out takes the code with the session", async () => {
    const { t, userId, session } = await enrolled();
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("authSessions").collect()) await ctx.db.delete(row._id);
    });
    // `withSession` signs back in with a fresh session, which owes a code.
    expect(await session.query(api.functions.admin.amIAdmin, {})).toBe(false);
    expect(userId).toBeTruthy();
  });

  test("somebody who is not staff learns nothing and can enroll nothing", async () => {
    const { t } = await staff();
    const stranger = await t.run(
      async (ctx) => await ctx.db.insert("users", { email: "someone@example.com", emailVerificationTime: Date.now() } as never),
    );
    const as = withSession(t, stranger);
    expect(await as.query(api.functions.staffSecondFactor.myStaffFactor, {})).toEqual({ staff: false });
    await expect(as.mutation(api.functions.staffSecondFactor.startEnrollment, {})).rejects.toThrow();
    await expect(as.mutation(api.functions.staffSecondFactor.submitCode, { code: "123456" })).rejects.toThrow();
  });
});

describe("the key", () => {
  test("only the session that started enrolling is shown the key, and only until it is confirmed", async () => {
    const { t, userId, session } = await staff();
    await session.mutation(api.functions.staffSecondFactor.startEnrollment, {});
    const shown = await session.query(api.functions.staffSecondFactor.myStaffFactor, {});
    expect(shown).toMatchObject({ staff: true, setupUri: expect.stringMatching(/^otpauth:\/\/totp\//) });
    const other = withSession(t, userId);
    expect(await other.query(api.functions.staffSecondFactor.myStaffFactor, {})).not.toHaveProperty("setupKey");
    expect(
      await other.mutation(api.functions.staffSecondFactor.submitCode, { code: await currentCode(t, userId) }),
    ).toEqual({ ok: false, reason: "not_enrolling" });
    await session.mutation(api.functions.staffSecondFactor.submitCode, { code: await currentCode(t, userId) });
    expect(await session.query(api.functions.staffSecondFactor.myStaffFactor, {})).not.toHaveProperty("setupKey");
  });

  test("the key is in no table", async () => {
    const { t, userId, session } = await staff();
    await session.mutation(api.functions.staffSecondFactor.startEnrollment, {});
    const shown = (await session.query(api.functions.staffSecondFactor.myStaffFactor, {})) as { setupKey: string };
    const rows = await t.run(async (ctx) => await ctx.db.query("staffSecondFactors").collect());
    expect(JSON.stringify(rows)).not.toContain(shown.setupKey);
    expect(userId).toBeTruthy();
  });

  test("an enrolled account swaps its key only from a session that typed a code", async () => {
    const { t, userId } = await enrolled();
    const thief = withSession(t, userId);
    await expect(thief.mutation(api.functions.staffSecondFactor.startEnrollment, {})).rejects.toThrow(/current authenticator/);
  });
});

describe("replacing the key", () => {
  test("the current key stays in force until the new one is confirmed, then only the new one works", async () => {
    const { t, userId, session } = await enrolled();
    const before = await t.run(async (ctx) =>
      await ctx.db.query("staffSecondFactors").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
    );
    await session.mutation(api.functions.staffSecondFactor.startEnrollment, {});
    // Another device still owes a code from the current key, and still works with one.
    const laptop = withSession(t, userId);
    expect(await laptop.query(api.functions.admin.amIAdmin, {})).toBe(false);
    const oldKey = (await staffFactorKey(userId, before!.nonce))!;
    expect(
      await laptop.mutation(api.functions.staffSecondFactor.submitCode, { code: await totpCode(oldKey, totpStep(Date.now()) + 1) }),
    ).toEqual({ ok: true });

    const shown = (await session.query(api.functions.staffSecondFactor.myStaffFactor, {})) as { setupKey: string };
    const newKey = base32Decode(shown.setupKey);
    expect(
      await session.mutation(api.functions.staffSecondFactor.submitCode, { code: await totpCode(newKey, totpStep(Date.now())) }),
    ).toEqual({ ok: true });
    const phone = withSession(t, userId);
    expect(
      await phone.mutation(api.functions.staffSecondFactor.submitCode, { code: await totpCode(oldKey, totpStep(Date.now()) + 1) }),
    ).toEqual({ ok: false, reason: "wrong" });
  });
});

describe("guessing", () => {
  test("a code is taken once", async () => {
    const { t, userId, session } = await enrolled();
    const laptop = withSession(t, userId);
    const used = await t.run(async (ctx) =>
      (await ctx.db.query("staffSecondFactors").withIndex("by_user", (q) => q.eq("userId", userId)).unique())!.lastUsedStep,
    );
    const row = await t.run(async (ctx) =>
      await ctx.db.query("staffSecondFactors").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
    );
    const replay = await totpCode((await staffFactorKey(userId, row!.nonce))!, used);
    expect(await laptop.mutation(api.functions.staffSecondFactor.submitCode, { code: replay })).toEqual({
      ok: false,
      reason: "wrong",
    });
    expect(session).toBeTruthy();
  });

  test("five wrong codes make the account wait, even for the right one", async () => {
    const { t, userId } = await enrolled();
    const laptop = withSession(t, userId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await laptop.mutation(api.functions.staffSecondFactor.submitCode, { code: "000000" })).toMatchObject({ ok: false });
    }
    const right = await currentCode(t, userId, 1);
    expect(await laptop.mutation(api.functions.staffSecondFactor.submitCode, { code: right })).toEqual({
      ok: false,
      reason: "wait",
    });
  });

  test("a lost authenticator is reset from the deploy key only", async () => {
    process.env[STAFF_SECOND_FACTOR_ENV_VAR] = "required";
    const { t, userId } = await enrolled();
    expect(await t.mutation(internal.functions.staffSecondFactor.resetForEmail, { email: ADMIN })).toBe(1);
    const fresh = withSession(t, userId);
    expect(await fresh.query(api.functions.staffSecondFactor.myStaffFactor, {})).toMatchObject({ enrolled: false, standing: "enroll" });
  });
});
