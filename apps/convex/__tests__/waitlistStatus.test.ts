import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { WAITLIST_PAGE } from "../functions/lib/adminFns/waitlist";
import { hashToken } from "../functions/lib/crypto";
import { OPEN_SIGNUP_ENV_VAR, USE_FOR_MAX } from "../functions/lib/waitlist";
import { ANSWERS_PER_HOUR } from "../functions/waitlistStatus";
import { asUser, createUser, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * THE WAITLIST STATUS RECEIPT — `functions/waitlistStatus.ts`,
 * `functions/lib/waitlistReceipt.ts`, and the receipt half of joining.
 *
 * Tex launch (2026-10-20): joining puts the person on a page that shows
 * where they stand, live, and lets them add or change an optional answer,
 * with no account. What must hold: only the browser that made the row gets a
 * receipt; a phone number or address alone reads and writes nothing; a
 * removal still reads as waiting; "You're in" names a Tex line only when one
 * is configured; and staff can find people by their answers.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failures in this file.
 *
 *   `joinWaitlist` issuing a receipt on "already"                       1
 *   `rowForReceipt` skipping the hash (matching the raw receipt)        3
 *   `status` reporting `removed` as its own state                       1
 *   `answer` accepting a let-in row                                      1
 *   `describe` ignoring `useForAt`                                       1
 */

const STAFF = "staff@context.invalid";
const PHONE = "+15555550142";
const OTHER = "+15555550143";
const LINE = "+15555550199";

beforeEach(() => {
  vi.stubEnv(ADMIN_EMAILS_ENV_VAR, STAFF);
  vi.stubEnv(OPEN_SIGNUP_ENV_VAR, "");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_not_real");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token-not-real");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA_test_not_real");
  vi.stubEnv("TEX_LINE_NUMBERS", LINE);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    throw new Error(`network access attempted: ${String(input)}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function join(t: TestConvex, phone: string) {
  return await t.action(api.functions.phoneSignIn.start, { phone });
}

async function rowOf(t: TestConvex, phone: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("waitlist")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .unique(),
  );
}

async function staff(t: TestConvex) {
  return asUser(t, await createUser(t, STAFF));
}

const status = (t: TestConvex, receipt: string) => t.query(api.functions.waitlistStatus.status, { receipt });
const answer = (t: TestConvex, receipt: string, useFor: string) =>
  t.mutation(api.functions.waitlistStatus.answer, { receipt, useFor });

describe("joining hands out a receipt", () => {
  test("a new phone gets one, kept only as its hash", async () => {
    const t = setupTest();
    const joined = await join(t, PHONE);
    expect(joined.status).toBe("joined");
    expect(joined.receipt).toMatch(/^[0-9a-f]{64}$/);
    const row = await rowOf(t, PHONE);
    expect(row?.receiptHash).toBe(await hashToken(joined.receipt!));
    expect(JSON.stringify(row)).not.toContain(joined.receipt!);
  });

  test("typing a listed number again gets no receipt and makes no second row", async () => {
    const t = setupTest();
    const first = await join(t, PHONE);
    const again = await join(t, PHONE);
    expect(again).toEqual({ status: "already", phone: PHONE });
    const rows = await t.run((ctx) => ctx.db.query("waitlist").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.receiptHash).toBe(await hashToken(first.receipt!));
  });

  test("a new address gets one too, and an address already listed does not", async () => {
    const t = setupTest();
    const joined = await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    expect(joined.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect(await status(t, joined.receipt!)).toMatchObject({
      state: "waiting",
      contact: { kind: "email", masked: "j•••@studio.test" },
    });
    const again = await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    expect(again).toEqual({ status: "already" });
  });
});

describe("the status page", () => {
  test("shows waiting with the last four digits and no line", async () => {
    const t = setupTest();
    const { receipt } = await join(t, PHONE);
    expect(await status(t, receipt!)).toEqual({
      state: "waiting",
      contact: { kind: "phone", ending: "0142" },
      useFor: null,
      texLine: null,
    });
  });

  test("an unknown, malformed or other row's receipt reads nothing", async () => {
    const t = setupTest();
    const mine = await join(t, PHONE);
    await join(t, OTHER);
    expect(await status(t, "0".repeat(64))).toBeNull();
    expect(await status(t, "")).toBeNull();
    expect(await status(t, PHONE)).toBeNull();
    // The stored hash is not itself a receipt.
    expect(await status(t, (await rowOf(t, PHONE))!.receiptHash!)).toBeNull();
    expect(await status(t, mine.receipt!.toUpperCase())).toBeNull();
    expect((await status(t, mine.receipt!))?.contact).toEqual({ kind: "phone", ending: "0142" });
  });

  test("staff letting the row in turns it into You're in, with the configured line", async () => {
    const t = setupTest();
    const { receipt } = await join(t, PHONE);
    const as = await staff(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [(await rowOf(t, PHONE))!._id] });
    expect(await status(t, receipt!)).toMatchObject({ state: "admitted", texLine: LINE });
  });

  test("let in with no Tex line configured says admitted and names no number", async () => {
    vi.stubEnv("TEX_LINE_NUMBERS", "");
    const t = setupTest();
    const { receipt } = await join(t, PHONE);
    const as = await staff(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [(await rowOf(t, PHONE))!._id] });
    expect(await status(t, receipt!)).toMatchObject({ state: "admitted", texLine: null });
  });

  test("a removed row reads exactly like a waiting one, before and after a Let in", async () => {
    const t = setupTest();
    const { receipt } = await join(t, PHONE);
    const before = await status(t, receipt!);
    const as = await staff(t);
    const id = (await rowOf(t, PHONE))!._id;
    await as.mutation(api.functions.admin.removeFromWaitlist, { ids: [id] });
    expect(await status(t, receipt!)).toEqual(before);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    await t.run((ctx) => ctx.db.patch(id, { status: "removed" }));
    expect(await status(t, receipt!)).toEqual(before);
  });
});

describe("the optional answer", () => {
  test("can be added, changed and cleared, and the time is kept", async () => {
    const t = setupTest();
    const { receipt } = await join(t, PHONE);
    expect(await answer(t, receipt!, "  my kids' schedules  ")).toEqual({ saved: true });
    expect((await status(t, receipt!))?.useFor).toBe("my kids' schedules");
    expect((await rowOf(t, PHONE))?.useForAt).toBeTypeOf("number");
    expect(await answer(t, receipt!, "bills and the calendar")).toEqual({ saved: true });
    expect((await status(t, receipt!))?.useFor).toBe("bills and the calendar");
    expect(await answer(t, receipt!, "   ")).toEqual({ saved: true });
    expect((await status(t, receipt!))?.useFor).toBeNull();
  });

  test("is cut to the longest kept", async () => {
    const t = setupTest();
    const { receipt } = await join(t, PHONE);
    await answer(t, receipt!, "x".repeat(USE_FOR_MAX + 50));
    expect((await rowOf(t, PHONE))?.useFor).toHaveLength(USE_FOR_MAX);
  });

  test("cannot be written with the phone number, another row's receipt or a guess", async () => {
    const t = setupTest();
    await join(t, PHONE);
    const other = await join(t, OTHER);
    expect(await answer(t, PHONE, "hijacked")).toEqual({ saved: false });
    expect(await answer(t, "f".repeat(64), "hijacked")).toEqual({ saved: false });
    expect(await answer(t, other.receipt!, "mine")).toEqual({ saved: true });
    expect((await rowOf(t, PHONE))?.useFor).toBeUndefined();
    expect((await rowOf(t, OTHER))?.useFor).toBe("mine");
  });

  test("an address alone never writes over what the receipt holder wrote, even a cleared answer", async () => {
    const t = setupTest();
    const { receipt } = await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    await answer(t, receipt!, "");
    await t.mutation(api.functions.waitlist.describe, { email: "jon@studio.test", useFor: "planted" });
    expect((await status(t, receipt!))?.useFor).toBeNull();
  });

  test("stops once the row is let in", async () => {
    const t = setupTest();
    const { receipt } = await join(t, PHONE);
    await answer(t, receipt!, "before");
    const as = await staff(t);
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [(await rowOf(t, PHONE))!._id] });
    expect(await answer(t, receipt!, "after")).toEqual({ saved: false });
    expect((await status(t, receipt!))?.useFor).toBe("before");
  });

  test("is rate limited per row", async () => {
    const t = setupTest();
    const { receipt } = await join(t, PHONE);
    for (let i = 0; i < ANSWERS_PER_HOUR; i += 1) {
      expect(await answer(t, receipt!, `answer ${i}`)).toEqual({ saved: true });
    }
    expect(await answer(t, receipt!, "one too many")).toEqual({ saved: false });
    expect((await rowOf(t, PHONE))?.useFor).toBe(`answer ${ANSWERS_PER_HOUR - 1}`);
  });
});

describe("staff find people by their answers", () => {
  async function seed(t: TestConvex, answers: (string | null)[]): Promise<Id<"waitlist">[]> {
    const ids: Id<"waitlist">[] = [];
    for (const [i, useFor] of answers.entries()) {
      ids.push(
        await t.run((ctx) =>
          ctx.db.insert("waitlist", {
            phone: `+1555010${String(i).padStart(4, "0")}`,
            status: "waiting",
            joinedAt: 1_000 + i,
            source: "login",
            ...(useFor === null ? {} : { useFor }),
          }),
        ),
      );
    }
    return ids;
  }

  test("search matches inside an answer in any case, newest first", async () => {
    const t = setupTest();
    await seed(t, ["My Calendar is chaos", null, "bills", "calendars for the kids"]);
    const as = await staff(t);
    const found = await as.query(api.functions.admin.listWaitlist, { status: "waiting", search: "  CALENDAR " });
    expect(found.rows.map((row) => row.useFor)).toEqual(["calendars for the kids", "My Calendar is chaos"]);
    expect(found.filter).toEqual({ matches: 2, capped: false });
    expect(found.counts.waiting).toBe(4);
  });

  test("answered keeps rows with an answer, and no filter is the plain list", async () => {
    const t = setupTest();
    await seed(t, ["one", null, "two"]);
    const as = await staff(t);
    const answered = await as.query(api.functions.admin.listWaitlist, { status: "waiting", answered: true });
    expect(answered.rows.map((row) => row.useFor)).toEqual(["two", "one"]);
    const plain = await as.query(api.functions.admin.listWaitlist, { status: "waiting" });
    expect(plain.rows).toHaveLength(3);
    expect(plain.filter).toBeUndefined();
  });

  test("a filter looks past the newest page", async () => {
    const t = setupTest();
    await seed(t, ["needle", ...Array.from({ length: WAITLIST_PAGE + 5 }, () => "hay")]);
    const as = await staff(t);
    const found = await as.query(api.functions.admin.listWaitlist, { status: "waiting", search: "needle" });
    expect(found.rows.map((row) => row.useFor)).toEqual(["needle"]);
  });

  test("strangers cannot search", async () => {
    const t = setupTest();
    await seed(t, ["secret plans"]);
    const stranger = asUser(t, await createUser(t, "who@else.test"));
    await expect(
      stranger.query(api.functions.admin.listWaitlist, { status: "waiting", search: "secret" }),
    ).rejects.toThrow();
  });
});
