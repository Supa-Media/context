/**
 * SKIPPING THE PHONE STEP — someone who signed in with an email may tap
 * "Skip for now" and is not asked again (Dev2, 2026-10-29: "Ask, but let them
 * skip").
 *
 *  1. **Only the caller's own account.** The mutation names no user, so nobody
 *     can skip for somebody else, and a signed-out caller skips nothing.
 *  2. **Kept on the account.** One row per person, so another device, or the
 *     same one after signing out, is not asked again.
 *  3. **Never for a domain joiner.** Someone who came in through a work domain
 *     still needs a phone to keep their account if they leave it, and
 *     finishSetup still refuses them without one.
 *  4. **Adding a phone afterwards still works.**
 *  5. **Leaves with the account.**
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   myPhoneCheck ignores the skip row                              2
 *   skip inserts a new row every time                              1
 *   skip allowed for a domain joiner                               1
 *   drop the phoneCheckSkips sweep from personalRows               1
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, captureError, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";

const PHONE = "+15555550100";

beforeEach(() => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_not_real");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token-not-real");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA_test_not_real");
  vi.stubEnv("PHONE_CHECK", "required");
  vi.stubGlobal("fetch", async (url: string, init: { body: URLSearchParams }) => {
    if (new URL(url).pathname.endsWith("/Verifications")) {
      return new Response(JSON.stringify({ status: "pending" }), { status: 201 });
    }
    if (new URLSearchParams(init.body).get("Code") !== "123456") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ status: "approved", valid: true }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const check = (t: TestConvex, userId: Id<"users">) => asUser(t, userId).query(api.functions.phoneCheck.myPhoneCheck, {});
const skip = (t: TestConvex, userId: Id<"users">) => asUser(t, userId).mutation(api.functions.phoneCheck.skipPhoneCheck, {});
const skipRows = (t: TestConvex) => t.run((ctx) => ctx.db.query("phoneCheckSkips").collect());

async function domainJoiner(t: TestConvex) {
  const seyi = await createUser(t, "seyi@publicworship.life");
  const team = await createWorkspace(t, seyi, "pw", { kind: "shared" });
  await asUser(t, seyi).mutation(api.functions.workspaceDomains.addWorkspaceDomain, { workspaceId: team, domain: "publicworship.life" });
  const lee = await createUser(t, "lee@publicworship.life");
  await asUser(t, lee).mutation(api.functions.workspaceDomains.joinWithDomain, { slug: "pw" });
  return lee;
}

describe("skipping", () => {
  test("an email sign-up may skip, and is not asked again", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    expect(await check(t, ada)).toMatchObject({ required: true, canSkip: true });
    expect(await skip(t, ada)).toEqual({ status: "skipped" });
    expect(await check(t, ada)).toMatchObject({ required: false, confirmed: false, canSkip: false });
  });

  test("skipping twice keeps one row", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    await skip(t, ada);
    await skip(t, ada);
    expect(await skipRows(t)).toHaveLength(1);
  });

  test("one person skipping does not skip anybody else", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const bo = await createUser(t, "bo@example.invalid");
    await skip(t, ada);
    expect((await check(t, bo)).required).toBe(true);
  });

  test("signed out skips nothing", async () => {
    const t = setupTest();
    expect(errorCode(await captureError(() => t.mutation(api.functions.phoneCheck.skipPhoneCheck, {})))).toBe("NOT_AUTHENTICATED");
    expect(await skipRows(t)).toEqual([]);
  });

  test("a phone can still be added after skipping", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    await skip(t, ada);
    expect(await asUser(t, ada).action(api.functions.phoneCheck.sendPhoneCode, { phone: PHONE })).toEqual({ status: "sent", phone: PHONE });
    expect(await asUser(t, ada).action(api.functions.phoneCheck.confirmPhoneCode, { phone: PHONE, code: "123456" })).toEqual({
      status: "confirmed",
    });
    expect(await check(t, ada)).toMatchObject({ required: false, confirmed: true, phone: PHONE });
  });
});

describe("a domain joiner", () => {
  test("is not offered the skip, cannot take it, and setup still wants a phone", async () => {
    const t = setupTest();
    const lee = await domainJoiner(t);
    expect(await check(t, lee)).toMatchObject({ required: true, canSkip: false });
    expect(await skip(t, lee)).toEqual({ status: "not_allowed" });
    expect(await skipRows(t)).toEqual([]);
    expect((await check(t, lee)).required).toBe(true);
    expect(
      errorCode(await captureError(() => asUser(t, lee).mutation(api.functions.accountSetup.finishSetup, { name: "Lee" }))),
    ).toBe("SETUP_INCOMPLETE");
  });

  test("a skip saved before joining through a domain no longer counts", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@publicworship.life");
    const team = await createWorkspace(t, seyi, "pw", { kind: "shared" });
    await asUser(t, seyi).mutation(api.functions.workspaceDomains.addWorkspaceDomain, { workspaceId: team, domain: "publicworship.life" });
    const lee = await createUser(t, "lee@publicworship.life");
    await skip(t, lee);
    expect((await check(t, lee)).required).toBe(false);
    await asUser(t, lee).mutation(api.functions.workspaceDomains.joinWithDomain, { slug: "pw" });
    expect((await check(t, lee)).required).toBe(true);
  });
});

describe("leaving", () => {
  test("the row goes with the account", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    await skip(t, ada);
    await asUser(t, ada).mutation(api.functions.account.deleteAccount, {});
    expect(await skipRows(t)).toEqual([]);
  });
});
