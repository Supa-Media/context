import { describe, expect, jest, test } from "@jest/globals";
import { ConvexError } from "convex/values";

jest.mock("../features/observability/client", () => ({ trackEvent: jest.fn() }));
jest.mock("../features/auth/xPixel", () => ({ reportWaitlistSignUp: jest.fn() }));
jest.mock("../features/auth/metaPixel", () => ({ reportMetaLead: jest.fn() }));

import { BUSY, SEND_FAILED, sendError } from "../features/auth/useEmailSignIn";

describe("what a refused email code says", () => {
  test("too many codes: use the newest one, or wait the minutes the server gave", () => {
    const message = sendError(new ConvexError({ code: "TOO_MANY_CODES", retryAfterMs: 4 * 60_000 + 1 }));
    expect(message).toMatch(/newest one in your inbox/);
    expect(message).toMatch(/in 5 minutes\.$/);
    expect(sendError(new ConvexError({ code: "TOO_MANY_CODES", retryAfterMs: 1 }))).toMatch(/in 1 minute\.$/);
  });

  test("the other refusals keep their own words", () => {
    expect(sendError(new ConvexError({ code: "RATE_LIMITED" }))).toBe(BUSY);
    expect(sendError(new Error("network"))).toBe(SEND_FAILED);
  });
});
