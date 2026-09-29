import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * In-app feedback: what a report is allowed to be, and what happens to it when
 * it cannot go.
 *
 * The promise on the report screen is that a report is never lost to a bad
 * connection — offline, past the day's limit, or a send that failed and was
 * put off all leave it on the device until the server has taken it. The limit
 * itself is the server's; here it is only obeyed: a report the server said
 * must wait is held until the time it named. Against an in-memory store and a
 * fake transport, so a regression is a red test rather than a tester's report
 * that vanished.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   a failed send is discarded from the queue                             1
 *   a limited report is not held (sent again at once)                     2
 *   a rejected report blocks the queue instead of leaving it              1
 */

type MockResult =
  | { kind: "sent"; eventId: string }
  | { kind: "limited"; retryAfterMs: number }
  | { kind: "failed" }
  | { kind: "rejected" };

const mockSent: Array<{ clientReportId: string; activity?: string; screenshot?: unknown }> = [];
let mockAnswer: (id: string) => MockResult = () => ({ kind: "sent", eventId: "7f2c9a1b00112233445566778899aabb" });

jest.mock("../features/feedback/transport", () => ({
  sendFeedbackReport: async (report: { clientReportId: string; activity?: string; screenshot?: unknown }) => {
    const answer = mockAnswer(report.clientReportId);
    if (answer.kind === "sent") mockSent.push(report);
    return answer;
  },
}));

jest.mock("../features/offline/store", () => {
  const { memoryStore } = jest.requireActual<typeof import("../features/offline/memory")>(
    "../features/offline/memory",
  );
  const store = memoryStore();
  return { openStore: () => store, __store: store };
});

const queue = require("../features/feedback/queue") as typeof import("../features/feedback/queue");
const model = require("../features/feedback/model") as typeof import("../features/feedback/model");
const storeModule = require("../features/offline/store") as { __store: import("../features/offline/memory").KeyValueStore };

function draft(id: string, over: Partial<import("../features/feedback/model").FeedbackDraft> = {}) {
  return { clientReportId: id, message: "It jumped back", source: "menu" as const, screen: "/console/:context", ...over };
}

const NOON = new Date(2026, 8, 29, 12, 0, 0).getTime();

const SENT = () => ({ kind: "sent" as const, eventId: "7f2c9a1b00112233445566778899aabb" });

beforeEach(async () => {
  mockSent.length = 0;
  mockAnswer = SENT;
  for (const key of await storeModule.__store.keys()) await storeModule.__store.remove(key);
});

describe("the report's own rules", () => {
  test("a report needs words, and not too many", () => {
    expect(model.canSubmit("")).toBe(false);
    expect(model.canSubmit("   \n ")).toBe(false);
    expect(model.canSubmit("The board lost my card")).toBe(true);
    expect(model.canSubmit("x".repeat(model.MESSAGE_MAX + 1))).toBe(false);
  });

  test("the code shown after sending is the Sentry event id's first six", () => {
    expect(model.reportCode("7f2c9a1b00112233")).toBe("FB-7F2C9A");
    expect(model.reportCode("abcdef0123456789")).toBe("FB-ABCDEF");
  });

  test("base64 round-trips the screenshot bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    expect(Array.from(model.base64ToBytes(model.bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("sending, and keeping what cannot go", () => {
  test("online, it goes at once and nothing is left waiting", async () => {
    const outcome = await queue.submit(draft("a"), { online: true, now: NOON });
    expect(outcome).toEqual({ kind: "sent", code: "FB-7F2C9A" });
    expect(mockSent.map((r) => r.clientReportId)).toEqual(["a"]);
    expect(await queue.queuedCount()).toBe(0);
  });

  test("offline, it is kept and sent when the device is back", async () => {
    expect(await queue.submit(draft("b"), { online: false, now: NOON })).toEqual({ kind: "offline" });
    expect(mockSent).toHaveLength(0);
    expect(await queue.queuedCount()).toBe(1);

    await queue.drainQueue(NOON);
    expect(mockSent.map((r) => r.clientReportId)).toEqual(["b"]);
    expect(await queue.queuedCount()).toBe(0);
  });

  test("a failed send is not counted and not lost from the queue", async () => {
    await queue.enqueue(draft("c"));
    mockAnswer = () => ({ kind: "failed" });
    await queue.drainQueue(NOON);
    expect(await queue.queuedCount()).toBe(1);

    mockAnswer = SENT;
    await queue.drainQueue(NOON);
    expect(await queue.queuedCount()).toBe(0);
  });

  test("a report the server says is over the limit waits until the time it named", async () => {
    mockAnswer = () => ({ kind: "limited", retryAfterMs: 3 * 60 * 60 * 1000 });
    expect(await queue.submit(draft("r10"), { online: true, now: NOON })).toEqual({ kind: "limited" });
    expect(await queue.queuedCount()).toBe(1);

    // Before then it is not even tried.
    mockAnswer = SENT;
    await queue.drainQueue(NOON + 60_000);
    expect(mockSent).toHaveLength(0);

    await queue.drainQueue(NOON + 3 * 60 * 60 * 1000 + 1);
    expect(mockSent.map((r) => r.clientReportId)).toEqual(["r10"]);
    expect(await queue.queuedCount()).toBe(0);
  });

  test("hitting the limit while emptying the queue holds that report and stops", async () => {
    await queue.enqueue(draft("g"));
    await queue.enqueue(draft("h"));
    mockAnswer = (id) => (id === "g" ? { kind: "limited", retryAfterMs: 60_000 } : SENT());
    await queue.drainQueue(NOON);
    expect(mockSent).toEqual([]);
    expect(await queue.queuedCount()).toBe(2);

    mockAnswer = SENT;
    await queue.drainQueue(NOON + 1_000);
    expect(mockSent.map((r) => r.clientReportId)).toEqual(["h"]);
    await queue.drainQueue(NOON + 61_000);
    expect(mockSent.map((r) => r.clientReportId)).toEqual(["h", "g"]);
  });

  test("a report the server will never take is not kept, and does not block the rest", async () => {
    await queue.enqueue(draft("bad"));
    await queue.enqueue(draft("good"));
    mockAnswer = (id) => (id === "bad" ? { kind: "rejected" } : SENT());
    await queue.drainQueue(NOON);
    expect(mockSent.map((r) => r.clientReportId)).toEqual(["good"]);
    expect(await queue.queuedCount()).toBe(0);

    mockAnswer = () => ({ kind: "rejected" });
    expect(await queue.submit(draft("bad2"), { online: true, now: NOON })).toEqual({ kind: "rejected" });
    expect(await queue.queuedCount()).toBe(0);
  });

  test("a failed send from the screen is not queued by itself — the person chooses", async () => {
    mockAnswer = () => ({ kind: "failed" });
    expect(await queue.submit(draft("i"), { online: true, now: NOON })).toEqual({ kind: "failed" });
    expect(await queue.queuedCount()).toBe(0);
  });

  test("the old per-device count is removed", async () => {
    await storeModule.__store.set("context.feedback.sent.v1", JSON.stringify({ day: "2026-09-29", count: 10 }));
    await queue.drainQueue(NOON);
    expect(await storeModule.__store.get("context.feedback.sent.v1")).toBeNull();
  });

  test("the queued screenshot travels as the same bytes, and the log as the same text", async () => {
    const shot = { base64: model.bytesToBase64(new Uint8Array([9, 8, 7])), contentType: "image/jpeg" };
    await queue.submit(draft("d", { screenshot: shot, activity: "12:00  opened  /console/:context" }), {
      online: false,
      now: NOON,
    });
    await queue.drainQueue(NOON);
    const report = mockSent[0] as { activity?: string; screenshot?: { data: Uint8Array } };
    expect(report.activity).toBe("12:00  opened  /console/:context");
    expect(Array.from(report.screenshot?.data ?? [])).toEqual([9, 8, 7]);
  });

  test("deleting a waiting report removes it and only it", async () => {
    await queue.enqueue(draft("e"));
    await queue.enqueue(draft("f"));
    await queue.discard("e");
    await queue.drainQueue(NOON);
    expect(mockSent.map((r) => r.clientReportId)).toEqual(["f"]);
  });
});
