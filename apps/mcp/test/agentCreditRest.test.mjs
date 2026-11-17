/**
 * THE SPENT-CREDIT REST IS ONE RECORD FOR EVERY ISOLATE (`src/agent/creditRest.js`).
 *
 * Production on 2026-11-12: the plan credit ran out, and each isolate learned
 * that by sending the spent key and then the call again on Unified Billing.
 * These checks put two isolates on one object and show the second never sends
 * the spent key, that one of them probes when the rest ends, and that a probe
 * the credit answers puts the key back for both.
 *
 * Sabotage record: drop the `store.spent` write in `noteCreditSpent`, run this
 * file, and "a second isolate skips the spent key" fails because B sends
 * `x-api-key`. Put the write back. Pass `body.now` and `body.until` straight
 * through in `handleCreditRest`, and "a remote spent with until far in the
 * future is stored at most CREDIT_REST_MS ahead" stores the year that was
 * asked, and "a remote claim with a future now does not set a far-future
 * probeUntil" sets `probeUntil` a year out. Put the server clock back.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { aiGatewayConfig, requestViaGateway, resetCreditState } from "../src/agent/aiGateway.js";
import { CREDIT_REST_MS, CreditRestObject, createCreditCache, handleCreditRest } from "../src/agent/creditRest.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = `gw-token-${"a".repeat(20)}`;
const CREDIT = `sk-ant-credit-fixture-${"0".repeat(12)}`;
const T0 = 1_800_000_000_000;
const FIFTEEN_MINUTES = 15 * 60_000;
const CREDIT_SPENT = { error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } };

const CALL = {
  model: "anthropic/claude-haiku-5-5",
  system: "You are the fixture.",
  messages: [{ role: "user", text: "hello" }],
  tools: [],
};

function answer(text) {
  return { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 } };
}

function scripted(replies) {
  const queue = [...replies];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    const next = queue.shift();
    if (!next) throw new Error("fixture: the script ran out");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

/** One object behind a namespace, with storage that copies values the way a real object does. */
function openedNamespace() {
  const data = new Map();
  const storage = {
    get: async (key) => (data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : undefined),
    put: async (key, value) => {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
  const object = new CreditRestObject({ storage });
  return {
    storage,
    namespace: {
      idFromName: (name) => name,
      get: () => ({ fetch: (request) => object.fetch(request) }),
    },
  };
}

function namespace() {
  return openedNamespace().namespace;
}

function postCreditRest(env, body) {
  return handleCreditRest(
    new Request("https://mcp.context.lc/credit-rest", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function config() {
  return aiGatewayConfig({
    AI_GATEWAY_ACCOUNT_ID: ACCOUNT_ID,
    AI_GATEWAY_ID: "context-gw",
    AI_GATEWAY_TOKEN: TOKEN,
    ANTHROPIC_CREDIT_KEY: CREDIT,
    CREDIT_REST: namespace(),
  });
}

test("a second isolate skips a credit the first one saw spent, and one probe brings it back", async () => {
  resetCreditState();
  const cfg = config();
  const isolateA = createCreditCache();
  const isolateB = createCreditCache();
  const spent = scripted([
    { status: 400, body: CREDIT_SPENT },
    { status: 200, body: answer("from cloudflare") },
  ]);
  const first = await requestViaGateway(CALL, cfg, { fetchImpl: spent.fetchImpl, now: () => T0, creditCache: isolateA });
  assert.equal(first.paidBy, "cloudflare");
  assert.equal(spent.calls.length, 2, "the isolate that sees it spent still tries the key once, then Unified Billing");
  assert.equal(spent.calls[0].headers["x-api-key"], CREDIT);
  assert.equal("x-api-key" in spent.calls[1].headers, false);

  const skipped = scripted([{ status: 200, body: answer("from cloudflare") }]);
  const second = await requestViaGateway(CALL, cfg, { fetchImpl: skipped.fetchImpl, now: () => T0 + 1_000, creditCache: isolateB });
  assert.equal(skipped.calls.length, 1, "a second isolate does not send the spent key");
  assert.equal("x-api-key" in skipped.calls[0].headers, false);
  assert.equal(second.paidBy, "cloudflare");

  const still = scripted([{ status: 200, body: answer("still resting") }]);
  await requestViaGateway(CALL, cfg, { fetchImpl: still.fetchImpl, now: () => T0 + FIFTEEN_MINUTES - 1, creditCache: isolateB });
  assert.equal(still.calls.length, 1);
  assert.equal("x-api-key" in still.calls[0].headers, false);

  const probe = scripted([
    { status: 400, body: CREDIT_SPENT },
    { status: 200, body: answer("still cloudflare") },
  ]);
  const probed = await requestViaGateway(CALL, cfg, { fetchImpl: probe.fetchImpl, now: () => T0 + FIFTEEN_MINUTES + 1, creditCache: isolateA });
  assert.equal(probe.calls[0].headers["x-api-key"], CREDIT, "when the rest ends, one call tries the key");
  assert.equal(probed.paidBy, "cloudflare");
  const duringProbeRest = scripted([{ status: 200, body: answer("skipped again") }]);
  await requestViaGateway(CALL, cfg, { fetchImpl: duringProbeRest.fetchImpl, now: () => T0 + FIFTEEN_MINUTES + 2_000, creditCache: createCreditCache() });
  assert.equal("x-api-key" in duringProbeRest.calls[0].headers, false, "a probe that finds the credit still spent renews the rest for everyone");

  const back = scripted([{ status: 200, body: answer("the plan again") }]);
  const restoredProbe = await requestViaGateway(CALL, cfg, {
    fetchImpl: back.fetchImpl,
    now: () => T0 + 2 * FIFTEEN_MINUTES + 2_000,
    creditCache: isolateA,
  });
  assert.equal(back.calls[0].headers["x-api-key"], CREDIT);
  assert.equal(restoredProbe.paidBy, "credit");
  const after = scripted([{ status: 200, body: answer("both on the plan") }]);
  const restored = await requestViaGateway(CALL, cfg, { fetchImpl: after.fetchImpl, now: () => T0 + 2 * FIFTEEN_MINUTES + 3_000, creditCache: createCreditCache() });
  assert.equal(after.calls[0].headers["x-api-key"], CREDIT, "a probe the credit answers puts the key back for a fresh isolate");
  assert.equal(restored.paidBy, "credit");
});

test("once the rest has ended, one claim probes and the next skips until that probe lands", async () => {
  const data = new Map();
  const storage = {
    get: async (key) => (data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : undefined),
    put: async (key, value) => data.set(key, JSON.parse(JSON.stringify(value))),
  };
  const object = new CreditRestObject({ storage });
  await storage.put("book", { plan: { until: T0, probeUntil: 0 } });
  const claim = (now) => object.fetch(new Request("https://credit-rest.invalid/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "plan", now }),
  })).then((response) => response.json());
  const first = await claim(T0 + 1);
  const second = await claim(T0 + 2);
  assert.equal(first.probe, true);
  assert.equal(second.try, false);
});

test("a store that does not answer still tries the key", async () => {
  resetCreditState();
  const cfg = aiGatewayConfig({
    AI_GATEWAY_ACCOUNT_ID: ACCOUNT_ID,
    AI_GATEWAY_ID: "context-gw",
    AI_GATEWAY_TOKEN: TOKEN,
    ANTHROPIC_CREDIT_KEY: CREDIT,
    CREDIT_REST: {
      idFromName: () => "x",
      get: () => ({ fetch: () => new Promise(() => {}) }),
    },
  });
  const sent = scripted([{ status: 200, body: answer("from the plan") }]);
  const paid = await requestViaGateway(CALL, cfg, { fetchImpl: sent.fetchImpl, now: () => T0, creditCache: createCreditCache() });
  assert.equal(sent.calls.length, 1);
  assert.equal(sent.calls[0].headers["x-api-key"], CREDIT);
  assert.equal(paid.paidBy, "credit");
});

test("POST /credit-rest answers the gateway token and hides a wrong one", async () => {
  const env = { AI_GATEWAY_TOKEN: TOKEN, CREDIT_REST: namespace() };
  const wrong = await handleCreditRest(
    new Request("https://mcp.context.lc/credit-rest", { method: "POST", headers: { authorization: `Bearer ${"b".repeat(TOKEN.length)}` }, body: "{}" }),
    env,
  );
  assert.equal(wrong.status, 404);
  const claim = await handleCreditRest(
    new Request("https://mcp.context.lc/credit-rest", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "claim", name: "plan", now: T0 }),
    }),
    env,
  );
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), { try: true });
});

const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;

test("a remote spent with until far in the future is stored at most CREDIT_REST_MS ahead", async () => {
  const { storage, namespace: rest } = openedNamespace();
  const env = { AI_GATEWAY_TOKEN: TOKEN, CREDIT_REST: rest };
  const before = Date.now();
  const asked = before + ONE_YEAR;
  const lines = [];
  const original = console.log;
  console.log = (line) => {
    lines.push(String(line));
    original(line);
  };
  try {
    const response = await postCreditRest(env, { op: "spent", name: "plan", until: asked });
    assert.equal(response.status, 200);
    const kept = (await response.json()).until;
    const after = Date.now();
    assert.ok(kept >= before + CREDIT_REST_MS && kept <= after + CREDIT_REST_MS, `stored ${kept}, window ${before + CREDIT_REST_MS}..${after + CREDIT_REST_MS}`);
    assert.ok(kept < asked);
    assert.equal((await storage.get("book")).plan.until, kept);
    const logged = lines.flatMap((line) => {
      try {
        const row = JSON.parse(line);
        return row?.event === "credit_rest_clamped" ? [row] : [];
      } catch {
        return [];
      }
    });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].payer, "plan");
    assert.equal(logged[0].asked, asked);
    assert.equal(logged[0].kept, kept);
  } finally {
    console.log = original;
  }
});

test("a remote claim with a future now does not set a far-future probeUntil", async () => {
  const { storage, namespace: rest } = openedNamespace();
  const env = { AI_GATEWAY_TOKEN: TOKEN, CREDIT_REST: rest };
  const spent = await postCreditRest(env, { op: "spent", name: "plan", until: 1 });
  assert.equal(spent.status, 200);
  assert.equal((await spent.json()).until, 1, "a timestamp already past is stored as sent, so the rest has ended");
  const before = Date.now();
  const askedNow = before + ONE_YEAR;
  const claim = await postCreditRest(env, { op: "claim", name: "plan", now: askedNow });
  assert.equal(claim.status, 200);
  assert.equal((await claim.json()).probe, true);
  const probeUntil = (await storage.get("book")).plan.probeUntil;
  const after = Date.now();
  assert.ok(probeUntil > before && probeUntil <= after + 60_000, `probeUntil ${probeUntil} is not within a minute of the worker clock`);
  assert.ok(askedNow - probeUntil > 24 * 60 * 60 * 1000);
});
