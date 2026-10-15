/**
 * CONTENT REPORTS AFTER THEY ARE SENT — `functions/contentReports.ts`.
 *
 * Dev2 (2026-10-15): reports must show up in /admin, and the support address
 * must get an email. What matters: every sent report is one row and one mail,
 * however often it is retried; the mail carries ids and the reporter's words,
 * never the token, path or title; only staff can list or handle reports; no
 * `REPORTS_EMAIL` means no mail and the row still lands; and a reporter's rows
 * go with their account.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failures in this file.
 *
 *   `recordContentReport` call removed from `submitReport`              6
 *   idempotency check on `eventId` removed                              1
 *   `listReports` without `requireAdmin`                                1
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { reportsEmail } from "../functions/contentReports";
import { asUser, captureError, createUser, createWorkspace, drainScheduled, setupTest, type TestConvex } from "./fixtures.helpers";

const DSN = "https://0123456789abcdef0123456789abcdef@o1.ingest.example.invalid/42";
const STAFF = "staff@context.invalid";
const SUPPORT = "support@context.invalid";
const ORIGIN = "https://context.invalid";
const NOTE = "1-projects/beneath-the-chaos.md";
const ENV_KEYS = [ADMIN_EMAILS_ENV_VAR, "RESEND_API_KEY", "APP_ORIGIN", "REPORTS_EMAIL", "FEEDBACK_SENTRY_DSN", "FEEDBACK_INTAKE"] as const;

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let previous: Map<string, string | undefined>;
let realFetch: typeof globalThis.fetch;
let mailbox: Mail[];
let clientIds = 0;
function clientId(): string {
  clientIds += 1;
  return clientIds.toString(16).padStart(24, "0");
}

beforeEach(() => {
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env[ADMIN_EMAILS_ENV_VAR] = STAFF;
  process.env.RESEND_API_KEY = "re_fake_key_for_tests";
  process.env.APP_ORIGIN = ORIGIN;
  process.env.REPORTS_EMAIL = SUPPORT;
  process.env.FEEDBACK_SENTRY_DSN = DSN;
  delete process.env.FEEDBACK_INTAKE;
  mailbox = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("ingest.example.invalid")) return new Response("{}", { status: 200 });
    if (url !== "https://api.resend.com/emails") return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as Mail;
    mailbox.push({ to: body.to, subject: body.subject, text: body.text, html: body.html });
    return new Response(JSON.stringify({ id: "fake-message-id" }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    const was = previous.get(key);
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

async function staff(t: TestConvex) {
  const id = await t.run(async (ctx) => ctx.db.insert("users", { email: STAFF, emailVerificationTime: Date.now() } as never));
  return asUser(t, id);
}

async function scenario(t: TestConvex) {
  const ana = await createUser(t, "ana@example.invalid");
  const lk = await createUser(t, "lk@example.invalid");
  const anaOwn = await createWorkspace(t, ana, "ana");
  await createWorkspace(t, lk, "lk");
  const { token } = await asUser(t, ana).mutation(api.functions.shares.createShare, {
    workspaceId: anaOwn,
    path: NOTE,
    recipient: "@lk",
  });
  return { ana, lk, anaOwn, token };
}

async function report(t: TestConvex, as: Id<"users">, token: string, id = clientId()) {
  const receipt = await asUser(t, as).action(api.functions.reports.submitReport, {
    clientReportId: id,
    target: { kind: "share", token },
    reason: "harassment",
    details: "This keeps arriving.",
    platform: "ios",
  });
  await drainScheduled(t);
  return receipt;
}

describe("a sent report", { timeout: 30_000 }, () => {
  test("lands in the console and mails the support address once", async () => {
    const t = setupTest();
    const { lk, anaOwn, token } = await scenario(t);
    await report(t, lk, token);

    const listed = await (await staff(t)).query(api.functions.contentReports.listReports, { show: "open" });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      kind: "share",
      reason: "Harassment or bullying",
      details: "This keeps arriving.",
      resolved: true,
      reporter: "@lk",
      about: "@ana",
      workspace: "@ana",
      handledAt: null,
    });
    expect(listed[0]!.ids.workspaceId).toBe(anaOwn);

    expect(mailbox).toHaveLength(1);
    expect(mailbox[0]!.to).toBe(SUPPORT);
    expect(mailbox[0]!.subject).toBe("Report: Harassment or bullying, about a note shared with them");
    expect(mailbox[0]!.text).toContain("@lk reported");
    expect(mailbox[0]!.text).toContain("This keeps arriving.");
    expect(mailbox[0]!.text).toContain(`${ORIGIN}/admin/reports`);
  });

  test("a retry is one row and one mail", async () => {
    const t = setupTest();
    const { lk, token } = await scenario(t);
    const id = clientId();
    const first = await report(t, lk, token, id);
    const again = await report(t, lk, token, id);
    expect(again.eventId).toBe(first.eventId);
    expect(await (await staff(t)).query(api.functions.contentReports.listReports, { show: "all" })).toHaveLength(1);
    expect(mailbox).toHaveLength(1);
  });

  test("the mail never carries the share token or the note's path", async () => {
    const t = setupTest();
    const { lk, token } = await scenario(t);
    await report(t, lk, token);
    for (const part of [mailbox[0]!.subject, mailbox[0]!.text, mailbox[0]!.html]) {
      expect(part).not.toContain(token);
      expect(part).not.toContain(NOTE);
    }
  });

  test("the reporter's words are escaped in the mail's HTML", async () => {
    const t = setupTest();
    const { lk, token } = await scenario(t);
    await asUser(t, lk).action(api.functions.reports.submitReport, {
      clientReportId: clientId(),
      target: { kind: "share", token },
      reason: "other",
      details: '<img src="x" onerror="alert(1)">',
      platform: "ios",
    });
    await drainScheduled(t);
    expect(mailbox[0]!.html).not.toContain("<img");
    expect(mailbox[0]!.html).toContain("&lt;img");
  });

  test("no REPORTS_EMAIL: no mail, and the report is still in the console", async () => {
    delete process.env.REPORTS_EMAIL;
    const t = setupTest();
    const { lk, token } = await scenario(t);
    await report(t, lk, token);
    expect(mailbox).toHaveLength(0);
    expect(await (await staff(t)).query(api.functions.contentReports.listReports, { show: "open" })).toHaveLength(1);
  });

  test("REPORTS_EMAIL must be one address", () => {
    expect(reportsEmail({ REPORTS_EMAIL: " support@context.invalid " })).toBe(SUPPORT);
    expect(reportsEmail({ REPORTS_EMAIL: "a@x.invalid, b@x.invalid" })).toBeNull();
    expect(reportsEmail({ REPORTS_EMAIL: "not an address" })).toBeNull();
    expect(reportsEmail({})).toBeNull();
  });
});

describe("the console", { timeout: 30_000 }, () => {
  test("staff mark a report handled, and it leaves the open list", async () => {
    const t = setupTest();
    const { lk, token } = await scenario(t);
    await report(t, lk, token);
    const as = await staff(t);
    const [row] = await as.query(api.functions.contentReports.listReports, { show: "open" });
    await as.mutation(api.functions.contentReports.setReportHandled, { reportId: row!.id, handled: true });
    expect(await as.query(api.functions.contentReports.listReports, { show: "open" })).toHaveLength(0);
    const [handled] = await as.query(api.functions.contentReports.listReports, { show: "all" });
    expect(handled!.handledAt).not.toBeNull();
    expect(handled!.handledBy).toBe(STAFF);

    await as.mutation(api.functions.contentReports.setReportHandled, { reportId: row!.id, handled: false });
    expect(await as.query(api.functions.contentReports.listReports, { show: "open" })).toHaveLength(1);
  });

  test("nobody but staff can list or handle reports", async () => {
    const t = setupTest();
    const { ana, lk, token } = await scenario(t);
    await report(t, lk, token);
    const [row] = await (await staff(t)).query(api.functions.contentReports.listReports, { show: "all" });
    for (const as of [asUser(t, ana), asUser(t, lk)]) {
      expect(await captureError(() => as.query(api.functions.contentReports.listReports, { show: "all" }))).toBeDefined();
      expect(
        await captureError(() => as.mutation(api.functions.contentReports.setReportHandled, { reportId: row!.id, handled: true })),
      ).toBeDefined();
    }
    expect(await captureError(() => t.query(api.functions.contentReports.listReports, { show: "all" }))).toBeDefined();
  });
});
