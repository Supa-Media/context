import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";
import { syncSignInNumber } from "../functions/lib/numberList";
import { accountForPhone } from "../functions/lib/identities";

/**
 * ONE LIST OF NUMBERS (Dev2, 2026-11-16: "there should only be 1 list, having an account gives you access to Tex, there
 * is no separation"; `lib/numberList.ts`).
 *
 * A number confirmed at the app's phone sign-in is on `phoneLinks`, the list every reader goes by, beside numbers
 * linked by a code texted to Tex. Numbers confirmed before the list existed are put on it by the backfill. Turning Tex
 * off sticks; a number someone else holds on the list stays theirs; a changed sign-in number moves its own row only.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   `syncSignInNumber` call dropped from `recordConfirmedPhone` -> "a number confirmed in the app is on the list" fails
 *   `textingStopped` check dropped from `syncSignInNumber`      -> "someone who turned Tex off stays off" fails
 *   the by_phone check dropped from `syncSignInNumber`          -> "a number on the list for someone else stays theirs" fails
 *   `sign_in` rows not removed when the number changes          -> "changing the sign-in number moves only its own row" fails
 *   backfill skipping `unlinkedBefore`                          -> "the backfill ... leaves someone who unlinked before off" fails
 */

vi.setConfig({ testTimeout: 60_000 });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const NIA = "+15555550144";
const OTHER = "+15555550155";

/** An account whose number was confirmed at sign-in before the list existed: on the account, not on the list. */
async function legacySignIn(t: TestConvex, phone: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => await ctx.db.insert("users", { phone, phoneVerificationTime: Date.now(), isActive: true, createdAt: Date.now() }));
}

async function listed(t: TestConvex, phone: string) {
  return await t.run(async (ctx) => await ctx.db.query("phoneLinks").withIndex("by_phone", (q) => q.eq("phone", phone)).collect());
}

async function lookup(t: TestConvex, phone: string) {
  return await t.run(async (ctx) => await accountForPhone(ctx, phone));
}

async function backfill(t: TestConvex) {
  return await t.mutation(internal.functions.numberList.backfill, {});
}

describe("one list of numbers", () => {
  test("a number confirmed in the app is on the list, and looks up as that account", async () => {
    const t = setupTest();
    const nia = await createUser(t, "nia@example.invalid");
    await t.mutation(internal.functions.phoneCheck.recordConfirmedPhone, { userId: nia, phone: NIA });
    expect((await listed(t, NIA)).map((row) => [row.userId, row.via])).toEqual([[nia, "sign_in"]]);
    expect(await lookup(t, NIA)).toBe(nia);
  });

  test("the backfill puts a number confirmed before the list on it, once", async () => {
    const t = setupTest();
    const nia = await legacySignIn(t, NIA);
    expect(await lookup(t, NIA)).toBeNull();
    expect(await backfill(t)).toMatchObject({ added: 1, done: true });
    expect(await lookup(t, NIA)).toBe(nia);
    expect(await backfill(t)).toMatchObject({ added: 0 });
    expect(await listed(t, NIA)).toHaveLength(1);
  });

  test("someone who turned Tex off stays off", async () => {
    const t = setupTest();
    const nia = await createUser(t, "nia@example.invalid");
    await t.mutation(internal.functions.phoneCheck.recordConfirmedPhone, { userId: nia, phone: NIA });
    expect(await t.mutation(internal.functions.textLinks.unlinkByPhone, { phone: NIA })).toBe("unlinked");
    expect(await listed(t, NIA)).toEqual([]);
    await t.run(async (ctx) => void (await syncSignInNumber(ctx, nia)));
    await backfill(t);
    expect(await listed(t, NIA)).toEqual([]);
  });

  test("the backfill leaves someone who unlinked before the stop marker existed off", async () => {
    const t = setupTest();
    const nia = await legacySignIn(t, NIA);
    const personal = await createWorkspace(t, nia, "nia", { kind: "personal" });
    await t.run(async (ctx) => void (await ctx.db.insert("auditEvents", { workspaceId: personal, actorUserId: nia, action: "texts.phone.unlinked", paths: [], at: Date.now() } as never)));
    expect(await backfill(t)).toMatchObject({ added: 0, kept: 1 });
    expect(await listed(t, NIA)).toEqual([]);
  });

  test("a number on the list for someone else stays theirs", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    await t.run(async (ctx) => void (await ctx.db.insert("phoneLinks", { userId: ada, phone: NIA, linkedAt: Date.now(), via: "text" })));
    await legacySignIn(t, NIA);
    await backfill(t);
    expect((await listed(t, NIA)).map((row) => row.userId)).toEqual([ada]);
  });

  test("changing the sign-in number moves only its own row, never one made by texting a code", async () => {
    const t = setupTest();
    const nia = await legacySignIn(t, NIA);
    await t.run(async (ctx) => {
      await ctx.db.insert("phoneLinks", { userId: nia, phone: OTHER, linkedAt: Date.now(), via: "text" });
      await syncSignInNumber(ctx, nia);
    });
    expect((await t.run(async (ctx) => await ctx.db.query("phoneLinks").withIndex("by_user", (q) => q.eq("userId", nia)).collect())).map((row) => row.phone).sort()).toEqual([NIA, OTHER]);
    await t.run(async (ctx) => {
      await ctx.db.patch(nia, { phone: undefined, phoneVerificationTime: undefined });
      await syncSignInNumber(ctx, nia);
    });
    expect((await t.run(async (ctx) => await ctx.db.query("phoneLinks").withIndex("by_user", (q) => q.eq("userId", nia)).collect())).map((row) => row.phone)).toEqual([OTHER]);
  });
});
