import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * A report leaving the app for the control plane (`functions/feedback.ts`).
 *
 *  - What the app sends passes the server's own check — the same function,
 *    imported here — so the two halves cannot drift into a report the server
 *    refuses every time.
 *  - The server's answers become the queue's: over the limit waits for the
 *    time named, a refusal on shape is final, anything else is kept to retry.
 *  - "App and device" is a platform, a build, and a browser or system with its
 *    major version. Never the user agent string.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   the rate-limit answer is treated as a failure                          2
 *   a shape refusal is treated as a failure (kept forever)                1
 *   an oversized screenshot is sent anyway                                1
 *   the send never times out                                              1
 *   the whole user agent is sent as the version                           4
 */

jest.mock("react-native", () => ({ Platform: { OS: "web", Version: undefined } }));
jest.mock("convex/react", () => ({ useConvex: () => null, useQueries: () => ({}) }));
jest.mock("@context/convex/_generated/api", () => ({
  api: { functions: { feedback: { submitFeedback: "submitFeedback", feedbackAvailable: "feedbackAvailable" } } },
}));

const transport = require("../features/feedback/transport") as typeof import("../features/feedback/transport");
const device = require("../features/feedback/device") as typeof import("../features/feedback/device");
const { parseFeedbackReport } = require("../../convex/functions/lib/feedback/report") as typeof import("../../convex/functions/lib/feedback/report");
const { FEEDBACK_LIMITS } = require("@context/shared") as typeof import("@context/shared");

type Args = Parameters<import("../features/feedback/transport").FeedbackSubmitter>[0];

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

function report(over: Partial<import("../features/feedback/transport").FeedbackReport> = {}) {
  return {
    clientReportId: "00112233445566778899aabb",
    message: "The board lost my card",
    source: "top_bar" as const,
    screen: "/console/:context",
    activity: "14:02  opened  /console/:context\n14:03  error   TypeError · ref 0123abcd",
    errorEventId: "0123456789abcdef0123456789abcdef",
    screenshot: { data: JPEG, contentType: "image/jpeg" },
    ...over,
  };
}

function refused(data: Record<string, unknown>): Error {
  return Object.assign(new Error("refused"), { data });
}

let calls: Args[] = [];
function answering(answer: (args: Args) => Promise<{ eventId: string }>) {
  calls = [];
  transport.setFeedbackSubmitter(async (args) => {
    calls.push(args);
    return answer(args);
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: CHROME_MAC }, configurable: true });
  answering(async () => ({ eventId: "7f2c9a1b00112233445566778899aabb" }));
});

describe("what leaves the app", () => {
  test("passes the server's own check, field for field", async () => {
    expect(await transport.sendFeedbackReport(report())).toEqual({
      kind: "sent",
      eventId: "7f2c9a1b00112233445566778899aabb",
    });
    const args = calls[0]!;
    const parsed = parseFeedbackReport(args as never);
    expect(parsed.message).toBe("The board lost my card");
    expect(parsed.screen).toBe("/console/:context");
    expect(Array.from(new Uint8Array(args.screenshot!))).toEqual(Array.from(JPEG));
    expect(args.screenshotType).toBe("image/jpeg");
  });

  test("describes the browser by family and major version, never the user agent", async () => {
    await transport.sendFeedbackReport(report());
    const args = calls[0]!;
    expect(args.app.platform).toBe("web");
    expect(args.system).toEqual({ family: "chrome", version: "129" });
    expect(JSON.stringify(args)).not.toMatch(/Mozilla|Macintosh|AppleWebKit/);
  });

  test("an unticked log and a removed screenshot are not sent at all", async () => {
    await transport.sendFeedbackReport(report({ activity: "", screenshot: undefined }));
    const args = calls[0]!;
    expect(Object.keys(args)).not.toContain("activity");
    expect(Object.keys(args)).not.toContain("screenshot");
    expect(Object.keys(args)).not.toContain("screenshotType");
    parseFeedbackReport(args as never);
  });

  test("a screenshot over the server's cap is left off, and the words still go", async () => {
    const big = new Uint8Array(FEEDBACK_LIMITS.screenshotBytes + 1);
    big.set(JPEG);
    const result = await transport.sendFeedbackReport(report({ screenshot: { data: big, contentType: "image/jpeg" } }));
    expect(result.kind).toBe("sent");
    expect(calls[0]!.screenshot).toBeUndefined();
  });

  test("a screenshot sent from a view into a larger buffer sends only its own bytes", async () => {
    const backing = new Uint8Array([9, 9, ...JPEG, 9, 9]);
    await transport.sendFeedbackReport(report({ screenshot: { data: backing.subarray(2, 2 + JPEG.length), contentType: "image/jpeg" } }));
    expect(Array.from(new Uint8Array(calls[0]!.screenshot!))).toEqual(Array.from(JPEG));
  });
});

describe("what the server's answer means", () => {
  test("over the limit: wait for the time the server named", async () => {
    answering(async () => {
      throw refused({ code: "FEEDBACK_RATE_LIMITED", retryAfterMs: 90_000 });
    });
    expect(await transport.sendFeedbackReport(report())).toEqual({ kind: "limited", retryAfterMs: 90_000 });
  });

  test("over the limit with no usable time: an hour, and never more than a day", async () => {
    answering(async () => {
      throw refused({ code: "FEEDBACK_RATE_LIMITED" });
    });
    expect(await transport.sendFeedbackReport(report())).toEqual({ kind: "limited", retryAfterMs: 60 * 60 * 1000 });
    answering(async () => {
      throw refused({ code: "FEEDBACK_RATE_LIMITED", retryAfterMs: 10 * 24 * 60 * 60 * 1000 });
    });
    expect(await transport.sendFeedbackReport(report())).toEqual({ kind: "limited", retryAfterMs: 24 * 60 * 60 * 1000 });
  });

  test("refused on shape: final, so it is not kept to fail forever", async () => {
    answering(async () => {
      throw refused({ code: "FEEDBACK_INVALID", field: "activity" });
    });
    expect(await transport.sendFeedbackReport(report())).toEqual({ kind: "rejected" });
  });

  test("busy, unavailable, off, signed out or unreachable: kept to try again", async () => {
    for (const code of ["FEEDBACK_BUSY", "FEEDBACK_UNAVAILABLE", "FEEDBACK_NOT_CONFIGURED", "FEEDBACK_UNAUTHENTICATED"]) {
      answering(async () => {
        throw refused({ code });
      });
      expect(await transport.sendFeedbackReport(report())).toEqual({ kind: "failed" });
    }
    answering(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await transport.sendFeedbackReport(report())).toEqual({ kind: "failed" });
  });

  test("no answer in time is a failure, not a wait forever", async () => {
    answering(() => new Promise(() => {}));
    expect(await transport.sendFeedbackReport(report(), 20)).toEqual({ kind: "failed" });
  });

  test("before the app has a connection, nothing is sent and the report is kept", async () => {
    transport.setFeedbackSubmitter(null);
    expect(await transport.sendFeedbackReport(report())).toEqual({ kind: "failed" });
  });
});

describe("whether the report button is drawn", () => {
  test("follows what the server last said", () => {
    transport.setFeedbackAvailable(false);
    expect(transport.feedbackAvailable()).toBe(false);
    transport.setFeedbackAvailable(true);
    expect(transport.feedbackAvailable()).toBe(true);
  });
});

describe("app and device", () => {
  test("browsers by family, Edge and Chrome told apart", () => {
    expect(device.browserOf(CHROME_MAC)).toEqual({ family: "chrome", version: "129" });
    expect(
      device.browserOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.52"),
    ).toEqual({ family: "edge", version: "129" });
    expect(device.browserOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:130.0) Gecko/20100101 Firefox/130.0")).toEqual({
      family: "firefox",
      version: "130",
    });
    expect(
      device.browserOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"),
    ).toEqual({ family: "safari", version: "18" });
    expect(
      device.browserOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1"),
    ).toEqual({ family: "chrome", version: "129" });
    expect(device.browserOf("curl/8.4.0")).toEqual({ family: "other" });
  });

  test("phones by system and major version", () => {
    expect(device.describeDevice({ os: "ios", osVersion: "17.4.1" })).toEqual({
      app: { platform: "ios" },
      system: { family: "ios", version: "17" },
    });
    expect(device.describeDevice({ os: "android", osVersion: 34 })).toEqual({
      app: { platform: "android" },
      system: { family: "android", version: "34" },
    });
  });

  test("the build is a short commit, and anything odd is left off", () => {
    expect(device.describeDevice({ os: "web", osVersion: undefined, userAgent: "", build: "7677321184be6dd4651e8d7fe0ba0ebf71ef20eb" }).app).toEqual({
      platform: "web",
      build: "7677321184be",
    });
    expect(device.describeDevice({ os: "web", osVersion: undefined, userAgent: "", build: "<script>" }).app).toEqual({
      platform: "web",
    });
    expect(device.describeDevice({ os: "windows", osVersion: "11", userAgent: "" }).app.platform).toBe("web");
  });
});

describe("what the report screen says goes", () => {
  test("names the same build and browser that are sent", () => {
    const sent = device.describeDevice({ os: "web", osVersion: undefined, userAgent: CHROME_MAC, build: "7677321184be" });
    expect(device.describeForPerson(sent)).toBe("Context on the web, build 7677321184be, Chrome 129");
    expect(device.describeForPerson(device.describeDevice({ os: "ios", osVersion: "17.4" }))).toBe("Context app, iOS 17");
  });
});
