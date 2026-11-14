import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { OPEN_SIGNUP_ENV_VAR } from "../functions/lib/waitlist";
import { WAITLIST_BATCH } from "../functions/lib/adminFns/waitlist";
import { addMember, asUser, captureError, createUser, createWorkspace, drainScheduled, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * THE PEOPLE PAGE'S ACTS (`functions/consolePeople.ts`). Staff only.
 *
 * Let in tells only the untold phone rows it is given, never a told one.
 * Undo Remove moves removed rows back and nothing else. The open mail inboxes
 * are the personal workspaces whose ingestion row takes mail from anyone;
 * closing one keeps its allowlist and leaves nobody else's inbox alone.
 * Twilio is a fake `fetch`; the numbers are reserved fiction.
 */

const STAFF = "staff@context.invalid";
const ORIGIN = "https://context.test";

type Call = { host: string; body: URLSearchParams };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubEnv(ADMIN_EMAILS_ENV_VAR, STAFF);
  vi.stubEnv(OPEN_SIGNUP_ENV_VAR, "");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_not_real");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token-not-real");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA_test_not_real");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG_test_not_real");
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  vi.stubEnv("SITE_URL", ORIGIN);
  vi.stubEnv("CONVEX_SITE_URL", ORIGIN);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push({ host: url.host, body: new URLSearchParams(init?.body as URLSearchParams) });
    if (url.host === "api.twilio.com") return new Response(JSON.stringify({ sid: "SM_fake" }), { status: 201 });
    if (url.host === "verify.twilio.com") return new Response("{}", { status: 201 });
    throw new Error(`network access attempted: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const texts = () => calls.filter((call) => call.host === "api.twilio.com");

async function world(t: TestConvex) {
  const staff = await createUser(t, STAFF);
  const kayla = await createUser(t, "kayla@home.example");
  await createWorkspace(t, kayla, "kayla", { kind: "personal" });
  const boss = await createUser(t, "boss@work.example");
  await createWorkspace(t, boss, "boss", { kind: "personal" });
  const team = await createWorkspace(t, boss, "workteam", { kind: "shared" });
  await addMember(t, team, kayla, "member");
  return { staff, kayla, boss, team };
}

/** A let-in phone row nobody holds and nobody has been texted about. */
async function untold(t: TestConvex, phone: string): Promise<Id<"waitlist">> {
  return await t.run((ctx) =>
    ctx.db.insert("waitlist", { phone, status: "admitted", joinedAt: 1, admittedAt: 2, admittedMailAt: 2, source: "login" }),
  );
}

async function row(t: TestConvex, status: "waiting" | "admitted" | "removed", email: string): Promise<Id<"waitlist">> {
  return await t.run((ctx) => ctx.db.insert("waitlist", { email, status, joinedAt: 1, source: "homepage" }));
}

describe("who may use the acts", () => {
  test("a non-staff caller is refused by every act", async () => {
    const t = setupTest();
    const { kayla } = await world(t);
    const as = asUser(t, kayla);
    const id = await row(t, "removed", "x@home.example");
    const refusals = [
      captureError(() => as.mutation(api.functions.consolePeople.tellLetIn, { ids: [id] })),
      captureError(() => as.mutation(api.functions.consolePeople.restoreWaitlist, { ids: [id] })),
      captureError(() => as.query(api.functions.consolePeople.openInboxes, {})),
      captureError(() => as.mutation(api.functions.consolePeople.closeInbox, { userId: kayla })),
    ];
    for (const error of await Promise.all(refusals)) {
      expect(errorCode(error)).toBe("NOT_FOUND");
    }
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "removed" });
  });
});

describe("Let in on the untold phone rows", () => {
  test("texts only the untold rows given, and ignores told ones and ones not given", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    const given = await untold(t, "+15555550201");
    const told = await untold(t, "+15555550202");
    await t.run((ctx) => ctx.db.patch(told, { admittedTextAt: 5 }));
    const notGiven = await untold(t, "+15555550203");

    const result = await asUser(t, staff).mutation(api.functions.consolePeople.tellLetIn, { ids: [given, told] });
    expect(result).toEqual({ texted: 1, left: 0 });
    await drainScheduled(t);

    expect(texts().map((call) => call.body.get("To"))).toEqual(["+15555550201"]);
    expect(await t.run((ctx) => ctx.db.get(given))).toMatchObject({ admittedTextAt: expect.any(Number) });
    expect(await t.run((ctx) => ctx.db.get(told))).toMatchObject({ admittedTextAt: 5 });
    expect(await t.run((ctx) => ctx.db.get(notGiven))).not.toHaveProperty("admittedTextAt");
  });

  test("a second press on the same row texts nothing", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    const id = await untold(t, "+15555550204");
    const as = asUser(t, staff);
    await as.mutation(api.functions.consolePeople.tellLetIn, { ids: [id] });
    expect(await as.mutation(api.functions.consolePeople.tellLetIn, { ids: [id] })).toEqual({ texted: 0, left: 0 });
    await drainScheduled(t);
    expect(texts()).toHaveLength(1);
  });

  test("more than one press's batch is refused, before anything is texted", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    const ids: Id<"waitlist">[] = [];
    for (let i = 0; i <= WAITLIST_BATCH; i += 1) ids.push(await untold(t, `+1555555${String(1000 + i)}`));
    const error = await captureError(() =>
      asUser(t, staff).mutation(api.functions.consolePeople.tellLetIn, { ids }),
    );
    expect(String((error as { message?: unknown }).message)).toContain(`At most ${WAITLIST_BATCH} at a time.`);
    await drainScheduled(t);
    expect(texts()).toHaveLength(0);
  });
});

describe("Undo Remove", () => {
  test("moves only the removed rows given back to waiting, and tells nobody", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    const removed = await row(t, "removed", "back@home.example");
    const waiting = await row(t, "waiting", "waiting@home.example");
    const admitted = await row(t, "admitted", "in@home.example");
    const stillRemoved = await row(t, "removed", "gone@home.example");

    const result = await asUser(t, staff).mutation(api.functions.consolePeople.restoreWaitlist, {
      ids: [removed, waiting, admitted],
    });
    expect(result).toEqual({ changed: 1 });
    await drainScheduled(t);

    expect(await t.run((ctx) => ctx.db.get(removed))).toMatchObject({ status: "waiting" });
    expect(await t.run((ctx) => ctx.db.get(waiting))).toMatchObject({ status: "waiting" });
    expect(await t.run((ctx) => ctx.db.get(admitted))).toMatchObject({ status: "admitted" });
    expect(await t.run((ctx) => ctx.db.get(stillRemoved))).toMatchObject({ status: "removed" });
    expect(calls).toHaveLength(0);
  });
});

describe("open mail inboxes", () => {
  test("open inboxes are listed by their owner, and closing one keeps its allowlist and leaves no other", async () => {
    const t = setupTest();
    const { staff, kayla, boss } = await world(t);
    const as = asUser(t, staff);
    expect(await as.query(api.functions.consolePeople.openInboxes, {})).toEqual([]);

    const kaylaSpace = await t.run((ctx) =>
      ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", kayla)).first(),
    );
    await asUser(t, kayla).mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId: kaylaSpace!.workspaceId,
      allowAnySender: true,
    });
    expect(await as.query(api.functions.consolePeople.openInboxes, {})).toEqual([
      { userId: kayla, workspaceSlug: "kayla" },
    ]);

    expect(await as.mutation(api.functions.consolePeople.closeInbox, { userId: boss })).toEqual({ changed: false });
    expect(await as.mutation(api.functions.consolePeople.closeInbox, { userId: kayla })).toEqual({ changed: true });
    expect(await as.query(api.functions.consolePeople.openInboxes, {})).toEqual([]);
    expect(await as.mutation(api.functions.consolePeople.closeInbox, { userId: kayla })).toEqual({ changed: false });

    const settings = await t.run((ctx) =>
      ctx.db.query("ingestionSettings").withIndex("by_workspace", (q) => q.eq("workspaceId", kaylaSpace!.workspaceId)).unique(),
    );
    expect(settings).toMatchObject({ allowAnySender: false, allowedSenders: ["kayla@home.example"] });

    const audit = await t.run((ctx) => ctx.db.query("adminAuditEvents").collect());
    const closed = audit.filter((event) => event.action === "mail.inbox_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ actorUserId: staff, subject: String(kayla) });
  });
});
