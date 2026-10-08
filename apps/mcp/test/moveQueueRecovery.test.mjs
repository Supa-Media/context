import { test } from "node:test";
import assert from "node:assert/strict";
import { handleGatewayJobMessage, moveRetryForText } from "../src/moves/queueConsumer.js";

const env = { CONTROL_PLANE_URL: "https://control-plane.test", GATEWAY_SECRET: "test-secret" };

test("temporary materialization failures back off and stop after five tries", () => {
  const error = "move move-eeeeeeeeeeee: materialization paused: moving collaboration history: storage write failed";
  assert.deepEqual(moveRetryForText(error, 0), { delaySeconds: 30, transientFailures: 1 });
  assert.deepEqual(moveRetryForText(error, 4), { delaySeconds: 480, transientFailures: 5 });
  assert.equal(moveRetryForText(error, 5), null);
  assert.equal(moveRetryForText("not found", 0), null);
});

async function withFetch(fetchImpl, run) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = oldFetch;
  }
}

test("a redelivered move waits for the running lease instead of acknowledging its only message", async () => {
  const sent = [];
  await withFetch(async () => new Response(JSON.stringify({ job: { retryAfterMs: 1_500 } }), {
    headers: { "content-type": "application/json" },
  }), async () => {
    await handleGatewayJobMessage({
      body: { ticket: "opaque-ticket" },
      retry: () => assert.fail("a new message should be scheduled"),
    }, { ...env, GATEWAY_JOBS: { send: (...args) => sent.push(args) } });
  });
  assert.deepEqual(sent, [[{ ticket: "opaque-ticket" }, { delaySeconds: 3 }]]);
});

test("a failed delayed send retries the current Queue message", async () => {
  const retries = [];
  await withFetch(async () => new Response(JSON.stringify({ job: { retryAfterMs: 1_500 } }), {
    headers: { "content-type": "application/json" },
  }), async () => {
    await handleGatewayJobMessage({
      body: { ticket: "opaque-ticket" },
      retry: (options) => retries.push(options),
    }, { ...env, GATEWAY_JOBS: { send: async () => { throw new Error("unavailable"); } } });
  });
  assert.deepEqual(retries, [{ delaySeconds: 30 }]);
});

test("a transient control-plane failure retries the Queue message", async () => {
  const retries = [];
  await withFetch(async () => { throw new Error("unavailable"); }, async () => {
    await handleGatewayJobMessage({
      body: { ticket: "opaque-ticket" },
      retry: (options) => retries.push(options),
    }, env);
  });
  assert.deepEqual(retries, [{ delaySeconds: 30 }]);
});

test("a terminal ticket is acknowledged without another retry", async () => {
  const retries = [];
  await withFetch(async () => new Response(JSON.stringify({ job: null }), {
    headers: { "content-type": "application/json" },
  }), async () => {
    await handleGatewayJobMessage({
      body: { ticket: "opaque-ticket" },
      retry: (options) => retries.push(options),
    }, env);
  });
  assert.deepEqual(retries, []);
});
