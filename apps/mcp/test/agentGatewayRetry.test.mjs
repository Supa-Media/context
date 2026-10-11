/**
 * THE AI GATEWAY ROAD, WHEN THE PROVIDER IS BUSY.
 *
 * Decided by the owner (2026-10-09): a call the provider answered 429, 503 or
 * 529, or that never got through, is sent once more after a short wait; a
 * 400 or a 500 is not (it would only fail twice) and a timed-out call is not
 * (it has spent the round's deadline). The answer says it was retried and
 * after what, so the turn's trace and a benchmark can count it. These checks
 * drive `requestViaGateway` with a scripted `fetchImpl` and an injected wait,
 * so nothing sleeps.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aiGatewayConfig,
  requestViaGateway,
  resetCreditState,
} from "../src/agent/aiGateway.js";
import { ProviderError } from "../src/agent/providers.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const GATEWAY_ID = "context-gw";
const TOKEN = `gw-token-${"a".repeat(20)}`;
const T0 = 1_800_000_000_000;

const CALL = {
  model: "anthropic/claude-haiku-5-5",
  system: "You are the fixture.",
  messages: [{ role: "user", text: "when is the launch" }],
  tools: [],
};

function env(overrides = {}) {
  return {
    AI_GATEWAY_ACCOUNT_ID: ACCOUNT_ID,
    AI_GATEWAY_ID: GATEWAY_ID,
    AI_GATEWAY_TOKEN: TOKEN,
    ...overrides,
  };
}

/** A fetch that answers from a script and records every request it was sent. */
function scripted(replies) {
  const queue = [...replies];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      headers: { ...init.headers },
      body: JSON.parse(init.body),
    });
    const next = queue.shift();
    if (!next) throw new Error("fixture: the script ran out");
    const text =
      typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

function answer(text) {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

test("a 529, a 503 or a 429 is retried once after a wait, and the answer says it was", async () => {
  const cfg = aiGatewayConfig(env());
  for (const status of [529, 503, 429]) {
    resetCreditState();
    const waits = [];
    const busyThenFine = scripted([
      { status, body: { error: { type: "overloaded_error" } } },
      { status: 200, body: answer("after the wait") },
    ]);
    const result = await requestViaGateway(CALL, cfg, {
      fetchImpl: busyThenFine.fetchImpl,
      now: () => T0,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    assert.equal(result.text, "after the wait", `a ${status} is retried`);
    assert.equal(busyThenFine.calls.length, 2);
    assert.deepEqual(waits, [750], "one wait before the second try");
    assert.deepEqual(
      result.retried,
      { status },
      "the turn is told what was retried",
    );
  }
});

test("a provider still busy on the second try is a ProviderError with that status, and there is no third try", async () => {
  resetCreditState();
  const cfg = aiGatewayConfig(env());
  const busy = scripted([
    { status: 529, body: "overloaded" },
    { status: 529, body: "overloaded" },
    { status: 200, body: answer("never asked") },
  ]);
  const failure = await requestViaGateway(CALL, cfg, {
    fetchImpl: busy.fetchImpl,
    now: () => T0,
    wait: async () => {},
  }).then(
    () => null,
    (error) => error,
  );
  assert.ok(failure instanceof ProviderError);
  assert.equal(failure.status, 529);
  assert.equal(busy.calls.length, 2);
});

test("a 400 or a 500 is not retried, and a first try that served is not marked retried", async () => {
  const cfg = aiGatewayConfig(env());
  for (const status of [400, 500]) {
    resetCreditState();
    const broken = scripted([
      { status, body: "no" },
      { status: 200, body: answer("never asked") },
    ]);
    const failure = await requestViaGateway(CALL, cfg, {
      fetchImpl: broken.fetchImpl,
      now: () => T0,
      wait: async () => {
        throw new Error("must not wait");
      },
    }).then(
      () => null,
      (error) => error,
    );
    assert.ok(
      failure instanceof ProviderError && failure.status === status,
      `a ${status} fails at once`,
    );
    assert.equal(broken.calls.length, 1);
  }
  resetCreditState();
  const fine = scripted([{ status: 200, body: answer("first time") }]);
  const served = await requestViaGateway(CALL, cfg, {
    fetchImpl: fine.fetchImpl,
    now: () => T0,
  });
  assert.equal(served.retried, null);
});

test("a request that never got through is retried once; a timed-out one is not", async () => {
  resetCreditState();
  const cfg = aiGatewayConfig(env());
  let calls = 0;
  const flaky = async (url, init) => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return scripted([{ status: 200, body: answer("second time") }]).fetchImpl(
      url,
      init,
    );
  };
  const result = await requestViaGateway(CALL, cfg, {
    fetchImpl: flaky,
    now: () => T0,
    wait: async () => {},
  });
  assert.equal(result.text, "second time");
  assert.deepEqual(result.retried, { status: null });

  resetCreditState();
  let hung = 0;
  // Stands in for the round's deadline running out: fetch rejects with the
  // AbortError the timer's abort produces.
  const hangs = async () => {
    hung += 1;
    throw Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
  };
  const timedOut = await requestViaGateway(CALL, cfg, {
    fetchImpl: hangs,
    now: () => T0,
    wait: async () => {
      throw new Error("must not wait");
    },
  }).then(
    () => null,
    (error) => error,
  );
  assert.ok(timedOut instanceof ProviderError, "a hang is a provider error");
  assert.equal(hung, 1, "and is not retried");
});
