import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, isGhRateLimitError, MAX_BACKOFF_MS, responseWaitMs, retryOnRateLimit } from "./github-rate-limit.mjs";

const NOW = 1_700_000_000_000;

test("responseWaitMs is null for a success, a 404, and a 403 with no rate-limit signs", () => {
  assert.equal(responseWaitMs({ status: 200, headers: {}, now: NOW }), null);
  assert.equal(responseWaitMs({ status: 404, headers: {}, body: "Not Found", now: NOW }), null);
  assert.equal(responseWaitMs({ status: 403, headers: {}, body: "Resource not accessible by integration", now: NOW }), null);
});

test("responseWaitMs honours retry-after in seconds", () => {
  assert.equal(responseWaitMs({ status: 429, headers: { "retry-after": "42" }, now: NOW }), 42_000);
  const headers = new Headers({ "retry-after": "7" });
  assert.equal(responseWaitMs({ status: 403, headers, now: NOW }), 7_000);
});

test("responseWaitMs waits until x-ratelimit-reset, for a Headers instance and a plain object", () => {
  const reset = String(Math.floor(NOW / 1000) + 90);
  const plain = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset };
  const headers = new Headers(plain);
  assert.equal(responseWaitMs({ status: 403, headers: plain, now: NOW }), 91_000);
  assert.equal(responseWaitMs({ status: 403, headers, now: NOW }), 91_000);
  // A reset already past still waits at least a second.
  assert.equal(responseWaitMs({ status: 429, headers: { "x-ratelimit-reset": String(Math.floor(NOW / 1000) - 60) }, now: NOW }), 1_000);
});

test("responseWaitMs falls back to backoff when the rate limit names no reset", () => {
  assert.equal(responseWaitMs({ status: 429, headers: {}, now: NOW, attempt: 0 }), 15_000);
  assert.equal(responseWaitMs({ status: 403, headers: {}, body: "API rate limit exceeded", now: NOW, attempt: 2 }), 60_000);
});

test("backoffMs doubles and caps at five minutes", () => {
  assert.equal(MAX_BACKOFF_MS, 300_000);
  assert.equal(backoffMs(0), 15_000);
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(4), 240_000);
  assert.equal(backoffMs(5), 300_000);
  assert.equal(backoffMs(40), 300_000);
});

test("isGhRateLimitError recognises a gh rate limit and nothing else", () => {
  assert.equal(isGhRateLimitError({ stderr: "gh: API rate limit exceeded for installation ID 123. (HTTP 403)" }), true);
  assert.equal(isGhRateLimitError({ message: "Command failed: gh api rate_limit (HTTP 429)" }), true);
  assert.equal(isGhRateLimitError({ stderr: "gh: Not Found (HTTP 404)" }), false);
  assert.equal(isGhRateLimitError(new Error("GitHub GET /x failed (HTTP 404).")), false);
});

test("retryOnRateLimit retries a rate-limited call and returns its value", async () => {
  const waits = [];
  let calls = 0;
  const value = await retryOnRateLimit(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("rate limited"), { wait: 5_000 });
      return "done";
    },
    {
      deadline: NOW + 600_000,
      waitFor: (error) => error.wait ?? null,
      now: () => NOW,
      sleep: async (ms) => waits.push(ms),
      log: () => {},
    },
  );
  assert.equal(value, "done");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5_000, 5_000]);
});

test("retryOnRateLimit rethrows a non-rate-limit error at once, without sleeping", async () => {
  const waits = [];
  const failure = new Error("GitHub GET /x failed (HTTP 404).");
  await assert.rejects(
    retryOnRateLimit(
      async () => {
        throw failure;
      },
      { deadline: NOW + 600_000, waitFor: () => null, now: () => NOW, sleep: async (ms) => waits.push(ms), log: () => {} },
    ),
    (error) => error === failure,
  );
  assert.deepEqual(waits, []);
});

test("retryOnRateLimit rethrows once the deadline has passed", async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(
    retryOnRateLimit(
      async () => {
        calls += 1;
        throw new Error("HTTP 429");
      },
      { deadline: NOW, waitFor: () => 1_000, now: () => NOW, sleep: async (ms) => waits.push(ms), log: () => {} },
    ),
    /HTTP 429/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("retryOnRateLimit never sleeps past the deadline", async () => {
  const waits = [];
  let now = NOW;
  let calls = 0;
  await assert.rejects(
    retryOnRateLimit(
      async () => {
        calls += 1;
        now += 10_000;
        throw new Error("rate limit");
      },
      {
        deadline: NOW + 60_000,
        waitFor: () => 600_000,
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
        log: () => {},
      },
    ),
    /rate limit/,
  );
  // The first attempt took 10 s, so 50 s were left: the 600 s wait is cut to 50 s.
  // The second attempt takes it past the deadline, and it is rethrown without a sleep.
  assert.deepEqual(waits, [50_000]);
  assert.equal(calls, 2);
});
