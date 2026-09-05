/**
 * The limit that stands between one signed-in account and the account's whole
 * Workers AI bill.
 *
 * `src/index.ts` used to document, in writing, that there was no rate limit
 * here — and `functions/meetings/transcribe.ts` documented that a signed-in
 * account was the only thing in front of the budget. Sign-up is open email OTP
 * with no invite gate, so "a signed-in account" is a barrier of approximately
 * zero, and each request may carry 8 MiB of audio.
 *
 * The two halves of the fix live in this file:
 *
 *  1. **`readCaller`** — the control plane sends an opaque per-account
 *     identifier in a header, so the limit has something to be keyed by and a
 *     surprising bill has something to be traced to. Bounded to exactly the
 *     shape it produces, because an unbounded header is an unbounded rate-limit
 *     key.
 *  2. **`checkRateLimit`** — which FAILS CLOSED. A limiter that answers
 *     "allowed" when it is broken or absent is not a limit, it is a comment.
 *
 * Each `it` below names the sabotage it catches.
 */
import { describe, expect, it } from "vitest";
import {
  CALLER_HEADER,
  RATE_LIMIT_PERIOD_SECONDS,
  RATE_LIMIT_REQUESTS,
  checkRateLimit,
  readCaller,
} from "./rateLimit";

/** A caller identifier in exactly the shape the control plane produces. */
const CALLER = "a".repeat(64);

/** A limiter that answers `success`, recording every key it was asked about. */
function fakeLimiter(success: boolean) {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      limit(options: { key: string }) {
        keys.push(options.key);
        return Promise.resolve({ success });
      },
    },
  };
}

/**
 * SABOTAGE: widen the pattern to `/^[0-9a-f]+$/`, or drop the length check, and
 * "refuses an identifier that is not exactly the shape we mint" goes RED.
 *
 * The header is attacker-controlled the moment the worker secret is: an
 * unbounded key is an unbounded string handed to the rate limiter, and a
 * caller free to vary its own key has no limit at all.
 */
describe("the caller identifier", () => {
  it("reads the one shape the control plane mints", () => {
    expect(readCaller(CALLER)).toBe(CALLER);
    expect(readCaller("0123456789abcdef".repeat(4))).toBe("0123456789abcdef".repeat(4));
  });

  it("refuses an identifier that is not exactly the shape we mint", () => {
    for (const value of [
      null,
      undefined,
      "",
      "   ",
      "a".repeat(63),
      "a".repeat(65),
      "a".repeat(4096),
      "A".repeat(64), // uppercase hex: one value, one encoding
      "g".repeat(64),
      `${"a".repeat(63)}-`,
      `${"a".repeat(32)} ${"a".repeat(31)}`,
    ]) {
      expect(readCaller(value as string | null), String(value).slice(0, 24)).toBeNull();
    }
  });

  it("tolerates the whitespace an HTTP header may arrive with", () => {
    // `Headers.get` strips optional whitespace itself, so this is belt and
    // braces rather than the primary defence — and it widens nothing, because
    // what is left must still be exactly 64 hex characters.
    expect(readCaller(`  ${CALLER}  `)).toBe(CALLER);
  });

  it("names a header, not a query parameter", () => {
    // A credential-adjacent value in a URL ends up in every log and proxy
    // between here and there. CLAUDE.md: no secrets in URLs.
    expect(CALLER_HEADER).toBe("x-caller-hash");
  });
});

/**
 * SABOTAGE: `catch { return "allowed" }`, or `if (!limiter) return "allowed"`,
 * and the two fail-closed tests go RED.
 *
 * Failing open is the whole finding coming back: an outage of the rate limiter,
 * or a binding somebody removed from wrangler.jsonc, would restore unlimited
 * inference silently and with a green deploy.
 */
describe("the limit", () => {
  it("lets a caller under the limit through, keyed by that caller", async () => {
    const limiter = fakeLimiter(true);
    expect(await checkRateLimit(limiter.binding, CALLER)).toBe("allowed");
    // Keyed by the caller and by nothing else. A constant key here would rate
    // limit the whole product as one account.
    expect(limiter.keys).toEqual([CALLER]);
  });

  it("refuses a caller over the limit", async () => {
    const limiter = fakeLimiter(false);
    expect(await checkRateLimit(limiter.binding, CALLER)).toBe("refused");
    expect(limiter.keys).toEqual([CALLER]);
  });

  it("fails closed when the limiter itself throws", async () => {
    const thrower = {
      limit(): Promise<{ success: boolean }> {
        throw new Error("rate limiter unavailable");
      },
    };
    expect(await checkRateLimit(thrower, CALLER)).toBe("unavailable");
  });

  it("fails closed when the limiter rejects", async () => {
    const rejecter = {
      limit: () => Promise.reject(new Error("rate limiter unavailable")),
    };
    expect(await checkRateLimit(rejecter, CALLER)).toBe("unavailable");
  });

  it("fails closed when the binding is not there at all", async () => {
    // `wrangler deploy` succeeds with a binding removed from wrangler.jsonc,
    // exactly as it does with Workers AI unprovisioned. The Worker must refuse
    // rather than quietly stop limiting.
    expect(await checkRateLimit(undefined, CALLER)).toBe("unavailable");
  });

  it("fails closed on an answer it cannot read", async () => {
    for (const answer of [null, undefined, {}, { success: "yes" }, "ok"]) {
      const odd = { limit: () => Promise.resolve(answer as unknown as { success: boolean }) };
      expect(await checkRateLimit(odd, CALLER)).toBe("unavailable");
    }
  });

  /**
   * The two numbers, justified against the real workload.
   *
   * `apps/mobile/features/meetings/capture/segments.ts` rotates a chunk every
   * 20 seconds, so ONE live recording is 3 requests a minute, and a person
   * plausibly running two devices is 6. There is no retry on this path by
   * design (retrying would mean keeping the audio), so nothing amplifies that.
   *
   * 20 a minute is over three times the two-device rate — a real user would
   * need seven simultaneous recordings to reach it — and an abuser scripting
   * the endpoint reaches it in seconds.
   */
  it("is set well above a real meeting and well below a script", () => {
    const CHUNKS_PER_MINUTE_PER_RECORDING = 3;
    const PLAUSIBLE_DEVICES = 2;
    const legitimate = CHUNKS_PER_MINUTE_PER_RECORDING * PLAUSIBLE_DEVICES;
    expect(RATE_LIMIT_PERIOD_SECONDS).toBe(60);
    expect(RATE_LIMIT_REQUESTS).toBeGreaterThanOrEqual(legitimate * 3);
    expect(RATE_LIMIT_REQUESTS).toBeLessThanOrEqual(legitimate * 5);
  });
});
