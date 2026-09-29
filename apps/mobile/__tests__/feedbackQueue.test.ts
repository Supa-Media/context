import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * In-app feedback: what a report is allowed to be, and what happens to it when
 * it cannot go.
 *
 * The promise on the report screen is that a report is never lost to a bad
 * connection — offline, past the day's limit, or a send that failed and was
 * put off all leave it on the device until Sentry has taken it — and that the
 * daily limit holds. Both are here against an in-memory store and a fake
 * transport, so a regression is a red test rather than a tester's report that
 * vanished.
 */

const mockSent: Array<{ clientReportId: string; activity?: string; screenshot?: unknown }> = [];
let mockTransportUp = true;

jest.mock("../features/observability/client", () => ({
  sendFeedbackReport: async (report: { clientReportId: string; activity?: string; screenshot?: unknown }) => {
    if (!mockTransportUp) return null;
    mockSent.push(report);
    return "7f2c9a1b00112233445566778899aabb";
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

beforeEach(async () => {
  mockSent.length = 0;
  mockTransportUp = true;
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

  test("the limit's day is the person's calendar day, and tomorrow starts at midnight", () => {
    expect(model.dayKey(NOON)).toBe("2026-09-29");
    expect(model.startOfTomorrow(NOON)).toBe(new Date(2026, 8, 30, 0, 0, 0).getTime());
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
    mockTransportUp = false;
    await queue.drainQueue(NOON);
    expect(await queue.queuedCount()).toBe(1);

    mockTransportUp = true;
    await queue.drainQueue(NOON);
    expect(await queue.queuedCount()).toBe(0);
  });

  test("the eleventh report of the day waits for tomorrow", async () => {
    for (let i = 0; i < model.DAILY_LIMIT; i++) {
      expect((await queue.submit(draft(`r${i}`), { online: true, now: NOON })).kind).toBe("sent");
    }
    expect(await queue.submit(draft("r10"), { online: true, now: NOON })).toEqual({ kind: "limited" });
    expect(mockSent).toHaveLength(model.DAILY_LIMIT);

    // Still today: nothing more goes.
    await queue.drainQueue(NOON + 60_000);
    expect(mockSent).toHaveLength(model.DAILY_LIMIT);

    // Tomorrow it goes.
    await queue.drainQueue(model.startOfTomorrow(NOON) + 1);
    expect(mockSent.at(-1)?.clientReportId).toBe("r10");
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
