/**
 * FEEDBACK INTAKE — the one path that carries a person's words and a picture
 * of their screen to a vendor on purpose, so every limit the report screen
 * promises is enforced here rather than trusted to the app.
 *
 *  1. **Only a signed-in person, only when configured.** No account, no DSN,
 *     or the brake on, and nothing is sent and nothing is stored.
 *  2. **Only the shapes the report screen lists.** The message is bounded; the
 *     screen and every activity line must be cleaned route names or error
 *     class names; the screenshot must be a small JPEG or PNG that is what it
 *     says. A refusal names the field and never echoes what was in it.
 *  3. **Ten a day, counted here.** A limit the app keeps is a courtesy; this
 *     one is the control, and a report that failed to send does not use it up.
 *  4. **A retry is the same report.** The same id from the same person
 *     answers the first report's event id and sends nothing twice; a send
 *     that died half way is resumed under the same Sentry event id, so Sentry
 *     keeps one copy.
 *  5. **The control plane keeps ids and times, never the report.** No
 *     message, route, log or picture in any row; the rows go with the account
 *     and after thirty days.
 *  6. **What reaches Sentry is the account id, never the email.**
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   isCleanRoute accepts any segment                                   3
 *   activity lines not checked                                         2
 *   screenshot magic bytes not checked                                 1
 *   rate limit counts nothing                                          2
 *   reports still being sent are not counted                           1
 *   duplicate client id sends again                                    1
 *   failed send keeps its reservation (counts against the limit)       1
 *   stale reservation gets a new event id                              1
 *   receipts not swept with the account                                1
 *   sweep deletes everything                                           1
 *   sweep stops after one batch                                        1
 *   the user's email added to the Sentry user                          1
 *   the brake FEEDBACK_INTAKE=disabled ignored                         2
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { EVENT_ID_PATTERN, isActivityLine, isCleanRoute } from "@context/shared";
import { api, internal } from "../_generated/api";
import { parseFeedbackReport } from "../functions/lib/feedback/report";
import { buildFeedbackEnvelope, parseDsn } from "../functions/lib/feedback/envelope";
import { asUser, createUser, drainScheduled, setupTest } from "./fixtures.helpers";

const DSN = "https://0123456789abcdef0123456789abcdef@o1.ingest.example.invalid/42";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const DAY = 24 * 60 * 60 * 1000;

let clientIds = 0;
function clientId(): string {
  clientIds += 1;
  return clientIds.toString(16).padStart(24, "0");
}

function report(over: Record<string, unknown> = {}) {
  return {
    clientReportId: clientId(),
    message: "The board lost my card",
    source: "top_bar",
    screen: "/console/:context",
    activity: "14:02  opened  /console/:context\n14:03  error   TypeError · ref 0123abcd",
    errorEventId: "0123456789abcdef0123456789abcdef",
    screenshot: JPEG.buffer.slice(0),
    screenshotType: "image/jpeg",
    app: { platform: "web", build: "7677321184be" },
    system: { family: "chrome", version: "129" },
    ...over,
  };
}

type Sent = { url: string; body: Uint8Array; headers: Record<string, string> };
let sent: Sent[] = [];
let sentryStatus = 200;

beforeEach(() => {
  sent = [];
  sentryStatus = 200;
  process.env.FEEDBACK_SENTRY_DSN = DSN;
  delete process.env.FEEDBACK_INTAKE;
  vi.stubGlobal("fetch", async (url: string, init: { body: Uint8Array; headers: Record<string, string> }) => {
    sent.push({ url: String(url), body: new Uint8Array(init.body), headers: init.headers });
    return new Response(JSON.stringify({ id: "x" }), { status: sentryStatus });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FEEDBACK_SENTRY_DSN;
});

function envelopeText(item: Sent): string {
  return new TextDecoder().decode(item.body);
}

async function signedIn() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.invalid");
  return { t, seyi, as: asUser(t, seyi) };
}

const submit = api.functions.feedback.submitFeedback;

describe("what a report may contain", () => {
  test("a cleaned route passes; a note path, a handle or a query does not", () => {
    expect(isCleanRoute("/")).toBe(true);
    expect(isCleanRoute("/console/:context/settings")).toBe(true);
    expect(isCleanRoute("/note/:context/:value")).toBe(true);
    expect(isCleanRoute("/console/@seyi")).toBe(false);
    expect(isCleanRoute("/console/seyi")).toBe(false);
    expect(isCleanRoute("/note/:context/1-projects/secret.md")).toBe(false);
    expect(isCleanRoute("/console?note=secret")).toBe(false);
    expect(isCleanRoute("/console//settings")).toBe(false);
    expect(isCleanRoute("console")).toBe(false);
  });

  test("an activity line is a time and a route, or a time and an error's class", () => {
    expect(isActivityLine("14:02  opened  /console/:context")).toBe(true);
    expect(isActivityLine("14:03  error   TypeError · ref 0123abcd")).toBe(true);
    expect(isActivityLine("14:03  error   Error")).toBe(true);
    expect(isActivityLine("14:02  opened  /note/:context/secret-plan.md")).toBe(false);
    expect(isActivityLine("14:03  error   Cannot read 'Secret plan'")).toBe(false);
    expect(isActivityLine("14:03  said    my password is hunter2")).toBe(false);
    expect(isActivityLine("25:03  opened  /")).toBe(false);
  });

  test("the whole report is checked, and a refusal never repeats what it refused", () => {
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ message: "   " }, "message"],
      [{ message: "x".repeat(4_001) }, "message"],
      [{ source: "email" }, "source"],
      [{ screen: "/console/@seyi-secret-handle" }, "screen"],
      [{ activity: "14:02  opened  /note/:context/seyi-secret-plan.md" }, "activity"],
      [{ activity: Array.from({ length: 201 }, () => "14:02  opened  /").join("\n") }, "activity"],
      [{ errorEventId: "not-an-id-seyi-secret" }, "errorEventId"],
      [{ clientReportId: "seyi-secret" }, "clientReportId"],
      [{ screenshot: new Uint8Array(2 * 1024 * 1024 + 1).buffer }, "screenshot"],
      [{ screenshot: new TextEncoder().encode("seyi-secret not a picture").buffer }, "screenshot"],
      [{ screenshotType: "image/svg+xml" }, "screenshot"],
      [{ screenshot: PNG.buffer.slice(0), screenshotType: "image/jpeg" }, "screenshot"],
      [{ app: { platform: "tv", build: "1" } }, "app"],
      [{ app: { platform: "web", build: "seyi secret build" } }, "app"],
      [{ system: { family: "chrome", version: "129; seyi-secret" } }, "system"],
    ];
    for (const [change, field] of refusals) {
      let caught: unknown = null;
      try {
        parseFeedbackReport(report(change) as never);
      } catch (error) {
        caught = error;
      }
      expect(caught, field).not.toBeNull();
      const text = JSON.stringify((caught as { data?: unknown }).data ?? String(caught));
      expect(text, field).toContain("FEEDBACK_INVALID");
      expect(text, field).toContain(field);
      expect(text, field).not.toMatch(/seyi|secret|xxxxxxxx/);
    }
  });

  test("an unknown browser becomes other, and a PNG is accepted as a PNG", () => {
    const parsed = parseFeedbackReport(
      report({ system: { family: "netscape", version: "4" }, screenshot: PNG.buffer.slice(0), screenshotType: "image/png" }) as never,
    );
    expect(parsed.system?.family).toBe("other");
    expect(parsed.screenshot?.contentType).toBe("image/png");
  });

  test("the DSN must be a Sentry-shaped https address", () => {
    expect(parseDsn(DSN)).toEqual({
      endpoint: "https://o1.ingest.example.invalid/api/42/envelope/",
      dsn: DSN,
    });
    expect(parseDsn("http://0123456789abcdef0123456789abcdef@host.invalid/42")).toBeNull();
    expect(parseDsn("https://host.invalid/42")).toBeNull();
    expect(parseDsn("https://key@host.invalid/not-a-project")).toBeNull();
    expect(parseDsn("")).toBeNull();
  });
});

describe("who may send, and when it is off", () => {
  test("a signed-out caller sends nothing", async () => {
    const t = setupTest();
    await expect(t.action(submit, report() as never)).rejects.toThrow(/FEEDBACK_UNAUTHENTICATED/);
    expect(sent).toEqual([]);
  });

  test("with no DSN, or the brake on, nothing is sent or stored", async () => {
    const { t, as } = await signedIn();
    delete process.env.FEEDBACK_SENTRY_DSN;
    await expect(as.action(submit, report() as never)).rejects.toThrow(/FEEDBACK_NOT_CONFIGURED/);
    process.env.FEEDBACK_SENTRY_DSN = DSN;
    process.env.FEEDBACK_INTAKE = "disabled";
    await expect(as.action(submit, report() as never)).rejects.toThrow(/FEEDBACK_NOT_CONFIGURED/);
    expect(sent).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("feedbackReceipts").collect())).toEqual([]);
  });

  test("availability is readable without sending anything", async () => {
    const { t, as } = await signedIn();
    expect(await as.query(api.functions.feedback.feedbackAvailable, {})).toBe(true);
    expect(await t.query(api.functions.feedback.feedbackAvailable, {})).toBe(false);
    process.env.FEEDBACK_INTAKE = "disabled";
    expect(await as.query(api.functions.feedback.feedbackAvailable, {})).toBe(false);
  });
});

describe("what reaches Sentry", () => {
  test("one envelope, to the project's endpoint, carrying what was listed", async () => {
    const { seyi, as } = await signedIn();
    const result = await as.action(submit, report() as never);
    expect(result.eventId).toMatch(EVENT_ID_PATTERN);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://o1.ingest.example.invalid/api/42/envelope/");
    const text = envelopeText(sent[0]!);
    const lines = text.split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ event_id: result.eventId, dsn: DSN });
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: "feedback" });
    const event = JSON.parse(lines[2]!);
    expect(event).toMatchObject({
      type: "feedback",
      event_id: result.eventId,
      user: { id: seyi },
      contexts: {
        feedback: {
          message: "The board lost my card",
          url: "/console/:context",
          source: "top_bar",
          associated_event_id: "0123456789abcdef0123456789abcdef",
        },
        browser: { name: "chrome", version: "129" },
      },
      tags: { "feedback.build": "7677321184be", "feedback.platform": "web" },
    });
    // A build is a tag, not a Sentry release: releases are the error SDK's.
    expect(event.release).toBeUndefined();
    expect(event.contexts.os).toBeUndefined();
    expect(text).toContain('"filename":"activity.txt"');
    expect(text).toContain("14:03  error   TypeError · ref 0123abcd");
    expect(text).toContain('"filename":"screenshot.jpg"');
  });

  test("the account id goes, the email never does", async () => {
    const { as } = await signedIn();
    await as.action(submit, report() as never);
    const event = JSON.parse(envelopeText(sent[0]!).split("\n")[2]!);
    expect(Object.keys(event.user)).toEqual(["id"]);
    expect(envelopeText(sent[0]!)).not.toContain("seyi@example.invalid");
  });

  test("an unticked log and a removed screenshot are not attached at all", async () => {
    const { as } = await signedIn();
    await as.action(submit, report({ activity: undefined, screenshot: undefined, screenshotType: undefined }) as never);
    const text = envelopeText(sent[0]!);
    expect(text).not.toContain("activity.txt");
    expect(text).not.toContain("screenshot.");
    expect(text.trimEnd().split("\n")).toHaveLength(3);
  });

  test("attachment lengths are bytes, so a multi-byte log still frames", () => {
    const envelope = buildFeedbackEnvelope({
      dsn: DSN,
      eventId: "a".repeat(32),
      userId: "u1",
      environment: "production",
      now: 0,
      report: parseFeedbackReport(report() as never),
    });
    const text = new TextDecoder().decode(envelope);
    const header = text.split("\n").find((line) => line.includes('"activity.txt"'))!;
    const expected = new TextEncoder().encode(
      "14:02  opened  /console/:context\n14:03  error   TypeError · ref 0123abcd",
    ).byteLength;
    expect(JSON.parse(header).length).toBe(expected);
  });
});

describe("ten a day, and a retry is the same report", () => {
  test("the same id twice sends once and answers the same event id", async () => {
    const { as } = await signedIn();
    const first = report();
    const a = await as.action(submit, first as never);
    const b = await as.action(submit, { ...first, screenshot: JPEG.buffer.slice(0) } as never);
    expect(b.eventId).toBe(a.eventId);
    expect(sent).toHaveLength(1);
  });

  test("the same id from two people is two reports", async () => {
    const { t, as } = await signedIn();
    const jon = await createUser(t, "jon@example.invalid");
    const shared = report();
    await as.action(submit, shared as never);
    await asUser(t, jon).action(submit, { ...shared, screenshot: JPEG.buffer.slice(0) } as never);
    expect(sent).toHaveLength(2);
  });

  test("the eleventh in a day is refused with when to try again", async () => {
    const { as } = await signedIn();
    for (let i = 0; i < 10; i++) await as.action(submit, report() as never);
    let caught: unknown = null;
    try {
      await as.action(submit, report() as never);
    } catch (error) {
      caught = error;
    }
    const data = (caught as { data?: { code?: string; retryAfterMs?: number } }).data;
    expect(data?.code).toBe("FEEDBACK_RATE_LIMITED");
    expect(data?.retryAfterMs).toBeGreaterThan(0);
    expect(data?.retryAfterMs).toBeLessThanOrEqual(DAY);
    expect(sent).toHaveLength(10);
  });

  test("reports still being sent count, so ten sent at once cannot become eleven", async () => {
    const { t, seyi, as } = await signedIn();
    for (let i = 0; i < 10; i++) {
      const held = await t.mutation(internal.functions.feedback.reserveFeedback, {
        userId: seyi,
        clientReportId: clientId(),
        now: Date.now(),
      });
      expect(held.kind).toBe("reserved");
    }
    await expect(as.action(submit, report() as never)).rejects.toThrow(/FEEDBACK_RATE_LIMITED/);
    expect(sent).toEqual([]);
  });

  test("reports older than a day no longer count", async () => {
    const { t, seyi, as } = await signedIn();
    await t.run(async (ctx) => {
      for (let i = 0; i < 10; i++) {
        await ctx.db.insert("feedbackReceipts", {
          userId: seyi,
          clientReportId: clientId(),
          eventId: "b".repeat(32),
          state: "sent",
          createdAt: Date.now() - DAY - 1_000,
        });
      }
    });
    await as.action(submit, report() as never);
    expect(sent).toHaveLength(1);
  });

  test("a failed send is not counted and can be sent again", async () => {
    const { t, as } = await signedIn();
    const first = report();
    sentryStatus = 500;
    await expect(as.action(submit, first as never)).rejects.toThrow(/FEEDBACK_UNAVAILABLE/);
    expect(await t.run((ctx) => ctx.db.query("feedbackReceipts").collect())).toEqual([]);
    sentryStatus = 200;
    const again = await as.action(submit, { ...first, screenshot: JPEG.buffer.slice(0) } as never);
    expect(again.eventId).toMatch(EVENT_ID_PATTERN);
    expect(sent).toHaveLength(2);
  });

  test("a send still in flight is not sent a second time", async () => {
    const { t, seyi, as } = await signedIn();
    const first = report();
    await t.run((ctx) =>
      ctx.db.insert("feedbackReceipts", {
        userId: seyi,
        clientReportId: first.clientReportId,
        eventId: "c".repeat(32),
        state: "sending",
        createdAt: Date.now(),
      }),
    );
    await expect(as.action(submit, first as never)).rejects.toThrow(/FEEDBACK_BUSY/);
    expect(sent).toEqual([]);
  });

  test("a send that died half way is resumed under the same event id", async () => {
    const { t, seyi, as } = await signedIn();
    const first = report();
    await t.run((ctx) =>
      ctx.db.insert("feedbackReceipts", {
        userId: seyi,
        clientReportId: first.clientReportId,
        eventId: "d".repeat(32),
        state: "sending",
        createdAt: Date.now() - 5 * 60 * 1000,
      }),
    );
    const result = await as.action(submit, first as never);
    expect(result.eventId).toBe("d".repeat(32));
    expect(JSON.parse(envelopeText(sent[0]!).split("\n")[0]!).event_id).toBe("d".repeat(32));
  });
});

describe("what the control plane keeps", () => {
  test("ids, a state and times — never the message, route, log or picture", async () => {
    const { t, as } = await signedIn();
    await as.action(submit, report() as never);
    const rows = await t.run((ctx) => ctx.db.query("feedbackReceipts").collect());
    expect(rows).toHaveLength(1);
    const keys = Object.keys(rows[0]!).filter((key) => !key.startsWith("_")).sort();
    expect(keys).toEqual(["clientReportId", "createdAt", "eventId", "sentAt", "state", "userId"]);
    expect(JSON.stringify(rows)).not.toMatch(/board lost|console|opened|TypeError/);
  });

  test("the rows go with the account", async () => {
    const { t, as } = await signedIn();
    await as.action(submit, report() as never);
    await as.mutation(api.functions.account.deleteAccount, {});
    expect(await t.run((ctx) => ctx.db.query("feedbackReceipts").collect())).toEqual([]);
  });

  test("rows older than thirty days are swept, newer ones kept", async () => {
    const { t, seyi } = await signedIn();
    await t.run(async (ctx) => {
      for (const age of [31 * DAY, 29 * DAY]) {
        await ctx.db.insert("feedbackReceipts", {
          userId: seyi,
          clientReportId: clientId(),
          eventId: "e".repeat(32),
          state: "sent",
          createdAt: Date.now() - age,
          sentAt: Date.now() - age,
        });
      }
    });
    await t.mutation(internal.functions.feedback.purgeExpiredFeedbackReceipts, {});
    const left = await t.run((ctx) => ctx.db.query("feedbackReceipts").collect());
    expect(left).toHaveLength(1);
    expect(left[0]!.createdAt).toBeGreaterThan(Date.now() - 30 * DAY);
  });

  test("a backlog bigger than one batch keeps going until it is gone", async () => {
    const { t, seyi } = await signedIn();
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("feedbackReceipts", {
          userId: seyi,
          clientReportId: clientId(),
          eventId: "f".repeat(32),
          state: "sent",
          createdAt: Date.now() - 40 * DAY,
        });
      }
    });
    await t.mutation(internal.functions.feedback.purgeExpiredFeedbackReceipts, { limit: 2 });
    await drainScheduled(t);
    expect(await t.run((ctx) => ctx.db.query("feedbackReceipts").collect())).toEqual([]);
  });
});
