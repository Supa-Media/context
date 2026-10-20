import { beforeEach, describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { MINUTE, enableMailSync, patchConnection, readConnection, scenario } from "./fixtures.helpers";

/**
 * A per-second or per-minute Gmail limit lifts within a minute, so the mailbox
 * waits out minutes, not the quarter-hour-and-doubling ladder a daily quota or
 * an outage gets. On production (2026-10-19) a rate-limited mailbox waited
 * fifteen and then thirty minutes, ignoring the pushes for new mail meanwhile:
 * an email that arrived at 15:42 reached its day at 16:12.
 *
 * SABOTAGE RECORD
 *   every rate limit on the long ladder         -> "a per-minute limit" and "climbs" failed
 *   daily quotas on the short ladder            -> "a daily quota" failed
 *   reason stored as given                      -> "only a plain reason" failed
 *   Google's "Retry after" ignored              -> "a lockout Google dated" failed
 */
describe("a Gmail rate limit backs off by what Google said", () => {
  beforeEach(() => enableMailSync());

  async function gmailOnly() {
    const s = await scenario();
    await patchConnection(s.t, s.connectionId, { syncStartedAt: Date.now() });
    return s;
  }

  async function limit(
    s: Awaited<ReturnType<typeof scenario>>,
    errorReason?: string,
    lockout: { errorCall?: string; errorRetryAfterAt?: number } = {},
  ) {
    await s.t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId: s.connectionId,
      product: "gmail",
      status: "failed",
      errorCode: "GOOGLE_RATE_LIMITED",
      error: "Google rate-limited this mailbox. The next scheduled pass will try again.",
      ...(errorReason === undefined ? {} : { errorReason }),
      ...lockout,
    });
    return await readConnection(s.t, s.connectionId);
  }

  test("a per-minute limit waits about a minute, and says which limit", async () => {
    const s = await gmailOnly();
    const row = await limit(s, "userRateLimitExceeded");
    expect(row.gmail?.lastFailureReason).toBe("userRateLimitExceeded");
    expect(row.gmail!.retryAt! - Date.now()).toBeLessThanOrEqual(2 * MINUTE + 1_000);
    expect(row.nextSyncAt!).toBe(row.gmail!.retryAt!);
  });

  test("a 429 with no reason is treated as a short limit", async () => {
    const s = await gmailOnly();
    const row = await limit(s);
    expect(row.gmail!.retryAt! - Date.now()).toBeLessThanOrEqual(2 * MINUTE + 1_000);
  });

  test("repeated limits climb, and stop at a quarter of an hour", async () => {
    const s = await gmailOnly();
    let row = await limit(s, "rateLimitExceeded");
    const first = row.gmail!.retryAt! - Date.now();
    row = await limit(s, "rateLimitExceeded");
    expect(row.gmail!.retryAt! - Date.now()).toBeGreaterThan(first);
    for (let attempt = 0; attempt < 8; attempt += 1) row = await limit(s, "rateLimitExceeded");
    expect(row.gmail!.retryAt! - Date.now()).toBeLessThanOrEqual(16 * MINUTE + 1_000);
  });

  test("a daily quota keeps the long ladder", async () => {
    const s = await gmailOnly();
    const row = await limit(s, "dailyLimitExceeded");
    expect(row.gmail!.retryAt! - Date.now()).toBeGreaterThanOrEqual(15 * MINUTE - 1_000);
  });

  test("only a plain reason is kept, and a success clears it", async () => {
    const s = await gmailOnly();
    let row = await limit(s, "<script>alert(1)</script>");
    expect(row.gmail?.lastFailureReason).toBeUndefined();
    row = await limit(s, "rateLimitExceeded");
    expect(row.gmail?.lastFailureReason).toBe("rateLimitExceeded");
    await patchConnection(s.t, s.connectionId, { syncStartedAt: Date.now() });
    await s.t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId: s.connectionId,
      product: "gmail",
      status: "synced",
      daysTouched: 0,
      bytesWritten: 0,
    });
    row = await readConnection(s.t, s.connectionId);
    expect(row.gmail?.lastFailureReason).toBeUndefined();
    expect(row.gmail?.retryAt).toBeUndefined();
  });

  /*
    Google locks a mailbox out for minutes at a time after sustained overuse
    and names the time in its message. Retrying on the minute ladder meant a
    failed pass every few minutes until then, and the mailbox read as stuck
    with nothing saying where (production, 2026-10-20).
  */
  test("a lockout Google dated waits until it lifts, and says which call met it", async () => {
    const s = await gmailOnly();
    const lifts = Date.now() + 40 * MINUTE;
    const row = await limit(s, "rateLimitExceeded", { errorCall: "messagesGet", errorRetryAfterAt: lifts });
    expect(row.gmail!.retryAt!).toBeGreaterThanOrEqual(lifts);
    expect(row.gmail?.lastFailureCall).toBe("messagesGet");
    const report = await s.t.query(internal.functions.googleSyncHealth.report, {});
    expect(report).toMatchObject({ gmailFailure: { "call:messagesGet": 1 } });
  });

  test("a lockout is waited out for a day at most, and only a plain call word is kept", async () => {
    const s = await gmailOnly();
    const row = await limit(s, "rateLimitExceeded", {
      errorCall: "/gmail/v1/users/me/messages/abc",
      errorRetryAfterAt: Date.now() + 3 * 24 * 60 * MINUTE,
    });
    expect(row.gmail!.retryAt! - Date.now()).toBeLessThanOrEqual(24 * 60 * MINUTE + 1_000);
    expect(row.gmail?.lastFailureCall).toBeUndefined();
  });

  test("the health report counts the reason and how long the wait is", async () => {
    const s = await gmailOnly();
    await limit(s, "userRateLimitExceeded");
    const report = await s.t.query(internal.functions.googleSyncHealth.report, {});
    expect(report).toMatchObject({ gmailFailure: { "reason:userRateLimitExceeded": 1, backingOffNow: 1, "retryIn:under5m": 1 } });
  });
});
