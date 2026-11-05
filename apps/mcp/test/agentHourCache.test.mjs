/**
 * THE ONE-HOUR PROMPT CACHE, AND WHAT HAPPENS IF IT IS REFUSED.
 *
 * A texted turn (`cachedThrough` set) marks its tools, system prompt and
 * history with Anthropic's one-hour cache, because people reply minutes apart
 * and a five-minute mark expired between most texts (owner, 2026-11-05). The
 * round's own end stays five minutes, and every other caller stays five
 * minutes. A one-hour mark refused by the gateway must never fail a turn: the
 * call is resent once without it, and later calls leave it off.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { aiGatewayConfig, gatewayBody, HOUR_MARK, requestViaGateway, resetCreditState, resetHourMarks, withoutHourMarks } from "../src/agent/aiGateway.js";

const MODEL = "anthropic/claude-haiku-5-5";
const HISTORY = [
  { role: "user", text: "when is the dentist" },
  { role: "assistant", text: "Tuesday at 3." },
];
const TEXTED = {
  model: MODEL,
  system: { stable: "You are Tex.", context: "About them: likes short replies." },
  messages: [...HISTORY, { role: "user", text: "and Monday?" }],
  tools: [{ name: "read_note", description: "read", inputSchema: { type: "object" } }],
  cachedThrough: HISTORY.length,
};
const ONE_OFF = { model: MODEL, system: "Judge this.", messages: [{ role: "user", text: "a reply" }], tools: [] };

const marks = (body) => {
  const found = [];
  JSON.parse(JSON.stringify(body), (key, value) => (key === "cache_control" ? (found.push(value), value) : value));
  return found;
};

function env() {
  return { AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", AI_GATEWAY_ID: "gw", AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}` };
}

function scripted(replies) {
  const queue = [...replies];
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    const next = queue.shift();
    if (!next) throw new Error("fixture: the script ran out");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const OK = { status: 200, body: { id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } };
const REFUSED = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "cache_control.ttl: unexpected field" } } };

test("a texted turn keeps its tools, system and history an hour, and its round's end five minutes", () => {
  const body = gatewayBody(TEXTED);
  for (const block of body.system) assert.deepEqual(block.cache_control, HOUR_MARK);
  assert.deepEqual(body.messages[HISTORY.length - 1].content.at(-1).cache_control, HOUR_MARK, "the history's end");
  assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" }, "the round's end");
  const all = [...marks(body.tools ?? []), ...marks(body.system), ...marks(body.messages)]; // the order Anthropic reads them
  const lastHour = all.map((mark) => mark.ttl === "1h").lastIndexOf(true);
  const firstShort = all.findIndex((mark) => mark.ttl === undefined);
  assert.ok(lastHour < firstShort, "Anthropic needs every one-hour mark before the five-minute ones");
});

test("a one-off call keeps five-minute marks: nothing reads it back, so an hour's write would be waste", () => {
  assert.ok(marks(gatewayBody(ONE_OFF)).every((mark) => mark.ttl === undefined));
});

test("withoutHourMarks turns every one-hour mark into a five-minute one and changes nothing else", () => {
  const body = gatewayBody(TEXTED);
  const plain = withoutHourMarks(body);
  assert.ok(marks(plain).every((mark) => mark.ttl === undefined));
  assert.equal(marks(plain).length, marks(body).length);
  assert.deepEqual(JSON.parse(JSON.stringify(plain).replaceAll('{"type":"ephemeral"}', '"X"')), JSON.parse(JSON.stringify(body).replaceAll('{"type":"ephemeral","ttl":"1h"}', '"X"').replaceAll('{"type":"ephemeral"}', '"X"')));
});

test("a refused one-hour mark is resent once without it, and later calls leave it off", async () => {
  resetCreditState();
  resetHourMarks();
  const cfg = aiGatewayConfig(env());
  const first = scripted([REFUSED, OK]);
  const answer = await requestViaGateway(TEXTED, cfg, { fetchImpl: first.fetchImpl });
  assert.equal(answer.text, "ok", "the turn still gets its answer");
  assert.equal(first.calls.length, 2);
  assert.ok(marks(first.calls[0]).some((mark) => mark.ttl === "1h"), "asked with the hour first");
  assert.ok(marks(first.calls[1]).every((mark) => mark.ttl === undefined), "resent without it");

  const later = scripted([OK]);
  await requestViaGateway(TEXTED, cfg, { fetchImpl: later.fetchImpl });
  assert.equal(later.calls.length, 1);
  assert.ok(marks(later.calls[0]).every((mark) => mark.ttl === undefined), "remembered: no second refused round");
  resetHourMarks();
});

test("a 400 that was not about the hour is not blamed on it: the hour stays on for later calls", async () => {
  resetCreditState();
  resetHourMarks();
  const cfg = aiGatewayConfig(env());
  const bad = scripted([REFUSED, REFUSED]);
  await assert.rejects(requestViaGateway(TEXTED, cfg, { fetchImpl: bad.fetchImpl }));
  const later = scripted([OK]);
  await requestViaGateway(TEXTED, cfg, { fetchImpl: later.fetchImpl });
  assert.ok(marks(later.calls[0]).some((mark) => mark.ttl === "1h"));
  resetHourMarks();
});

test("an accepted one-hour mark is sent once, with no second round", async () => {
  resetCreditState();
  resetHourMarks();
  const ok = scripted([OK]);
  await requestViaGateway(TEXTED, aiGatewayConfig(env()), { fetchImpl: ok.fetchImpl });
  assert.equal(ok.calls.length, 1);
  assert.ok(marks(ok.calls[0]).some((mark) => mark.ttl === "1h"));
});

test("a spent credit's 400 is not resent without the hour: the credit is rested as before", async () => {
  resetCreditState();
  resetHourMarks();
  const cfg = aiGatewayConfig({ ...env(), ANTHROPIC_CREDIT_KEY: `sk-ant-credit-fixture-${"0".repeat(12)}` });
  const spent = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } };
  const run = scripted([spent, OK]);
  const answer = await requestViaGateway(TEXTED, cfg, { fetchImpl: run.fetchImpl, now: () => 1_800_000_000_000 });
  assert.equal(answer.text, "ok");
  assert.equal(run.calls.length, 2, "the credit call, then Unified Billing: no extra round");
  assert.ok(marks(run.calls[1]).some((mark) => mark.ttl === "1h"), "the hour stays on");
  resetCreditState();
});
