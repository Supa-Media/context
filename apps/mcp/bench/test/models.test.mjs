// Tests for bench/models.mjs: where a benchmark's Claude calls go. All keys,
// ids and tokens are invented fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicGateway, BENCH_UNIFIED_BILLING_UNTIL, benchUnifiedBilling, cachedEmbeddings, claudeTransport, refusalLine, workersAi } from "../models.mjs";
import { MEANING_MODEL } from "../../src/search/meaning/embed.js";

const GATEWAY = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context",
  AI_GATEWAY_TOKEN: "fixture-gateway-token-0000000000",
};
const BODY = JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 10, messages: [] });

function recorder(...answers) {
  const calls = [];
  const credit = [];
  // `{ until, probeUntil }`, the same row the credit rest object keeps.
  const book = new Map();
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/credit-rest")) {
      const body = JSON.parse(init.body);
      credit.push(body);
      const now = Number(body.now);
      const row = book.get(body.name) ?? null;
      if (body.op === "spent") {
        book.set(body.name, { until: Math.max(row?.until ?? 0, Number(body.until) || 0), probeUntil: 0 });
        return new Response(JSON.stringify({ ok: true, until: book.get(body.name).until }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.op === "clear") {
        book.delete(body.name);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (!row || !Number.isFinite(now) || !(row.until > 0)) {
        return new Response(JSON.stringify({ try: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (now < row.until) return new Response(JSON.stringify({ try: false, until: row.until }), { status: 200, headers: { "content-type": "application/json" } });
      if (now < (row.probeUntil ?? 0)) return new Response(JSON.stringify({ try: false, until: row.probeUntil }), { status: 200, headers: { "content-type": "application/json" } });
      book.set(body.name, { ...row, probeUntil: now + 30_000 });
      return new Response(JSON.stringify({ try: true, probe: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    calls.push({ url, headers: init.headers, body: init.body });
    const [status, body] = answers.shift() ?? [200, { content: [] }];
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl, book, credit };
}

test("with the gateway's keys, calls go through the real gateway with the credit key", async () => {
  const { calls, fetchImpl } = recorder();
  const send = claudeTransport({ ...GATEWAY, ANTHROPIC_CREDIT_KEY: "fixture-credit-key-000000000000" }, fetchImpl);
  assert.equal(send.route, "gateway");
  const response = await send(BODY);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/context/anthropic/v1/messages");
  assert.equal(calls[0].headers["cf-aig-authorization"], "Bearer fixture-gateway-token-0000000000");
  assert.equal(calls[0].headers["cf-aig-collect-log"], "false");
  assert.equal(calls[0].headers["x-api-key"], "fixture-credit-key-000000000000");
  assert.deepEqual(JSON.parse(calls[0].headers["cf-aig-metadata"]), { feature: "benchmark" });
  assert.equal(calls[0].body, BODY);
});

test("a successful call after an expired rest sends clear, so production stops skipping that payer", async () => {
  const answered = [200, { model: "claude-haiku-5-5", usage: { input_tokens: 20, output_tokens: 5 } }];
  const { calls, fetchImpl, book, credit } = recorder(answered, answered);
  book.set("plan", { until: Date.now() - 1_000, probeUntil: 0 });
  const send = claudeTransport({ ...GATEWAY, ANTHROPIC_CREDIT_KEY: "fixture-credit-key-000000000000" }, fetchImpl);
  assert.equal((await send(BODY)).status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(credit.map((body) => body.op), ["claim", "clear"]);
  assert.equal(credit[1].name, "plan");
  assert.equal(book.has("plan"), false);
  assert.equal((await send(BODY)).status, 200);
  assert.deepEqual(credit.map((body) => body.op), ["claim", "clear", "claim"], "a later success, with no probe open, writes nothing");
});

test("a spent credit is not sent again, and Unified Billing is not asked", async () => {
  const { calls, fetchImpl } = recorder([400, { error: { message: "Your credit balance is too low" } }], [200, { content: [] }]);
  const send = claudeTransport({ ...GATEWAY, ANTHROPIC_CREDIT_KEY: "fixture-credit-key-000000000000" }, fetchImpl);
  assert.equal((await send(BODY)).status, 400);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["x-api-key"], "fixture-credit-key-000000000000");
  assert.equal((await send(BODY)).status, 402, "the shared rest skips the key, and nothing is sent keyless");
  assert.equal(calls.length, 1);
});

test("a refused key is not sent to Unified Billing; any other error is returned as is", async () => {
  const refused = recorder([401, { error: { message: "invalid x-api-key" } }], [200, { content: [] }]);
  const response = await claudeTransport({ ...GATEWAY, ANTHROPIC_API_KEY: "fixture-api-key-0000000000000000" }, refused.fetchImpl)(BODY);
  assert.equal(response.status, 401);
  assert.equal(refused.calls.length, 1);

  const bad = recorder([400, { error: { message: "messages: required" } }]);
  const other = await claudeTransport({ ...GATEWAY, ANTHROPIC_CREDIT_KEY: "fixture-credit-key-000000000000" }, bad.fetchImpl)(BODY);
  assert.equal(other.status, 400);
  assert.equal(bad.calls.length, 1);
});

test("stored keys are named by alias in order, then the credit key; a spent one is skipped and Unified Billing is never asked", async () => {
  const spent = [400, { error: { message: "Your credit balance is too low" } }];
  const { calls, fetchImpl } = recorder(spent, spent, spent);
  const send = claudeTransport({ ...GATEWAY, AI_GATEWAY_KEY_ALIASES: "first-credits,second-credits", ANTHROPIC_CREDIT_KEY: "fixture-credit-key-000000000000" }, fetchImpl);
  assert.equal((await send(BODY)).status, 400);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers["cf-aig-byok-alias"], "first-credits");
  assert.equal(calls[0].headers["x-api-key"], undefined);
  assert.equal(calls[1].headers["cf-aig-byok-alias"], "second-credits");
  assert.equal(calls[2].headers["x-api-key"], "fixture-credit-key-000000000000");
  assert.equal((await send(BODY)).status, 402);
  assert.equal(calls.length, 3, "the next call sends nothing: every payer is resting");
});

test("the gateway with no key at all does not call Unified Billing", async () => {
  const { calls, fetchImpl } = recorder();
  const response = await claudeTransport(GATEWAY, fetchImpl)(BODY);
  assert.equal(response.status, 402);
  assert.equal(calls.length, 0);
});

test("TEX_BENCH_UNIFIED_BILLING=on: after every alias is spent, one keyless call goes to Unified Billing, labelled cloudflare", async () => {
  const spent = [400, { error: { message: "Your credit balance is too low" } }];
  const paid = [200, { model: "claude-haiku-5-5", usage: { input_tokens: 1000, output_tokens: 100 } }];
  const { calls, fetchImpl } = recorder(spent, spent, paid);
  const before = BENCH_UNIFIED_BILLING_UNTIL - 60_000;
  const send = claudeTransport({ ...GATEWAY, AI_GATEWAY_KEY_ALIASES: "first-credits,second-credits", TEX_BENCH_UNIFIED_BILLING: "on" }, fetchImpl, () => before);
  assert.equal((await send(BODY)).status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].headers["cf-aig-byok-alias"], undefined);
  assert.equal(calls[2].headers["x-api-key"], undefined);
  assert.equal(calls[2].headers["cf-aig-authorization"], "Bearer fixture-gateway-token-0000000000");
  assert.deepEqual(JSON.parse(calls[2].headers["cf-aig-metadata"]), { feature: "benchmark", payer: "cloudflare" });
  assert.ok(send.costUsd > 0, "the Unified Billing call is priced into the run's spend");
  assert.equal((await send(BODY)).status, 200, "resting aliases are skipped and Unified Billing answers");
  assert.equal(calls.length, 4);
  assert.equal(calls[3].headers["cf-aig-byok-alias"], undefined);
});

test("Unified Billing stays off unless the setting is exactly on, and from 2026-12-01T00:00Z it is ignored", async () => {
  const spent = [400, { error: { message: "Your credit balance is too low" } }];
  for (const value of [undefined, "", "off", "true", "ON"]) {
    const { calls, fetchImpl } = recorder(spent);
    const send = claudeTransport({ ...GATEWAY, AI_GATEWAY_KEY_ALIASES: "first-credits", ...(value === undefined ? {} : { TEX_BENCH_UNIFIED_BILLING: value }) }, fetchImpl, () => BENCH_UNIFIED_BILLING_UNTIL - 60_000);
    assert.equal((await send(BODY)).status, 400, `setting ${JSON.stringify(value)}`);
    assert.equal(calls.length, 1, `setting ${JSON.stringify(value)} sends nothing keyless`);
  }
  const { calls, fetchImpl } = recorder(spent);
  const send = claudeTransport({ ...GATEWAY, AI_GATEWAY_KEY_ALIASES: "first-credits", TEX_BENCH_UNIFIED_BILLING: "on" }, fetchImpl, () => BENCH_UNIFIED_BILLING_UNTIL);
  assert.equal((await send(BODY)).status, 400);
  assert.equal(calls.length, 1, "expired: nothing keyless");
  assert.equal(BENCH_UNIFIED_BILLING_UNTIL, Date.parse("2026-12-01T00:00:00Z"));
  assert.equal(benchUnifiedBilling({ TEX_BENCH_UNIFIED_BILLING: "on" }, BENCH_UNIFIED_BILLING_UNTIL - 1), true);
  assert.equal(benchUnifiedBilling({ TEX_BENCH_UNIFIED_BILLING: "on" }, BENCH_UNIFIED_BILLING_UNTIL), false);
});

test("Unified Billing on: a working alias still pays, and nothing is sent keyless", async () => {
  const { calls, fetchImpl } = recorder([200, { content: [] }]);
  const send = claudeTransport({ ...GATEWAY, AI_GATEWAY_KEY_ALIASES: "first-credits", TEX_BENCH_UNIFIED_BILLING: "on" }, fetchImpl, () => BENCH_UNIFIED_BILLING_UNTIL - 60_000);
  assert.equal((await send(BODY)).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["cf-aig-byok-alias"], "first-credits");
});

test("without the gateway, an Anthropic key goes straight to Anthropic", async () => {
  const { calls, fetchImpl } = recorder();
  const send = claudeTransport({ ANTHROPIC_API_KEY: "fixture-api-key-0000000000000000" }, fetchImpl);
  assert.equal(send.route, "anthropic");
  await send(BODY);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].headers["x-api-key"], "fixture-api-key-0000000000000000");
  assert.equal(calls[0].headers["cf-aig-authorization"], undefined);
});

test("a half-set gateway is not a gateway, and with nothing set every call says why", async () => {
  const { calls, fetchImpl } = recorder();
  const send = claudeTransport({ AI_GATEWAY_ACCOUNT_ID: GATEWAY.AI_GATEWAY_ACCOUNT_ID }, fetchImpl);
  assert.equal(send.route, null);
  const response = await send(BODY);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error.message, /AI_GATEWAY_ACCOUNT_ID/);
  assert.equal(calls.length, 0);
});

test("a catalog model goes through Cloudflare's chat API on the runner's own gateway", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  const ai = workersAi(GATEWAY.AI_GATEWAY_ACCOUNT_ID, "fixture-workers-ai-token", "context", fetchImpl);
  await ai.run("openai/gpt-5-mini", { messages: [] }, { gateway: { id: "bench", collectLog: false } });
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions");
  assert.equal(calls[0].headers["cf-aig-gateway-id"], "context");
  assert.equal(calls[0].body.model, "openai/gpt-5-mini");

  await ai.run("@cf/zai-org/glm-4.7-flash", { messages: [] }).catch(() => {});
  assert.equal(calls[1].url.endsWith("/ai/run/@cf/zai-org/glm-4.7-flash"), true);
  assert.equal(calls[1].headers["cf-aig-gateway-id"], undefined);

  await assert.rejects(() => workersAi(GATEWAY.AI_GATEWAY_ACCOUNT_ID, "t", null, fetchImpl).run("dynamic/texts", {}, { gateway: {} }), /AI_GATEWAY_ID/);
});

test("a failed embedding call is tried again after a wait, and the last failure is logged before it is thrown", async () => {
  const waited = [];
  const logged = [];
  let calls = 0;
  const flaky = {
    async run(_model, input) {
      calls += 1;
      if (calls < 3) throw new Error("workers ai status 503");
      return { data: input.text.map(() => [1]) };
    },
  };
  const ai = cachedEmbeddings(flaky, { sleep: async (ms) => waited.push(ms), log: (line) => logged.push(line) });
  const answer = await ai.run(MEANING_MODEL, { text: ["a", "b"] });
  assert.equal(answer.data.length, 2);
  assert.equal(calls, 3);
  assert.deepEqual(waited, [1_000, 4_000]);
  assert.deepEqual(logged, []);

  const down = cachedEmbeddings({ run: async () => { throw new Error("workers ai status 429"); } }, { sleep: async () => {}, log: (line) => logged.push(line) });
  await assert.rejects(() => down.run(MEANING_MODEL, { text: ["c"] }), /status 429/);
  assert.deepEqual(logged, ["embedding failed after 3 tries: workers ai status 429"]);
});

test("a setup's own model call is never retried by the embedding cache", async () => {
  let calls = 0;
  const ai = cachedEmbeddings({ run: async () => { calls += 1; throw new Error("workers ai status 503"); } }, { sleep: async () => {}, log: () => {} });
  await assert.rejects(() => ai.run("@cf/zai-org/glm-4.7-flash", { messages: [] }), /503/);
  assert.equal(calls, 1);
});

test("a refused Claude call is logged with the provider's words, and the response still reaches the gateway", async () => {
  const logged = [];
  const refusal = { type: "error", error: { type: "invalid_request_error", message: "messages.4.content.1:\n  bad image" } };
  const fetchImpl = anthropicGateway(async () => new Response(JSON.stringify(refusal), { status: 400, headers: { "content-type": "application/json" } }), (line) => logged.push(line));
  const response = await fetchImpl("https://gateway.example/v1/messages", { body: BODY });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, "invalid_request_error", "the body is still readable by the gateway");
  assert.deepEqual(logged, ["Claude refused a call: 400 invalid_request_error: messages.4.content.1: bad image"]);

  const fine = anthropicGateway(async () => new Response("{}", { status: 200 }), (line) => logged.push(line));
  await fine("https://gateway.example/v1/messages", { body: BODY });
  assert.equal(logged.length, 1, "an answered call is not logged");
});

test("a refusal's words are read from the gateway's own shape too, and an empty body says so", () => {
  assert.equal(refusalLine(400, "application/json", '{"success":false,"errors":[{"code":2003,"message":"Insufficient   balance"}]}'), "Claude refused a call: 400 2003: Insufficient balance");
  assert.equal(refusalLine(400, "text/html", "<html>busy</html>"), "Claude refused a call: 400 <html>busy</html>");
  assert.equal(refusalLine(400, "application/json", ""), "Claude refused a call: 400 empty body (application/json)");
  assert.equal(refusalLine(400, null, null), "Claude refused a call: 400 no body read (no content-type)");
  assert.equal(refusalLine(400, null, JSON.stringify({ error: { message: "x".repeat(500) } })).length, "Claude refused a call: 400 ".length + 300);
});

// A Lab Dev run's answer processes each warmed every workspace with real embeddings (2026-11-26: ~300 s of a test's
// answer for ~30 s of turns). Sabotage: drop `readNew()` on a miss and the second embedder pays for "shared" again; keep
// a cut line and the vector comes back the wrong size.
test("embedders sharing a file read what another appended since they started, and skip a cut line", async () => {
  const { mkdtempSync, appendFileSync: append } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "embed-cache-")), "vectors.txt");
  const vector = (seed) => Array.from({ length: 1024 }, (_, i) => (i === seed ? 1 : 0));
  let calls = 0;
  const real = { run: async (_model, { text }) => ((calls += text.length), { data: text.map((t) => vector(t.length)) }) };
  const first = cachedEmbeddings(real, { file });
  const second = cachedEmbeddings(real, { file }); // started before the first wrote anything
  await first.run(MEANING_MODEL, { text: ["shared"] });
  append(file, "deadbeef QUJD\n"); // a cut line: skipped
  const again = await second.run(MEANING_MODEL, { text: ["shared"] });
  assert.equal(calls, 1, "the second process read the first's vector instead of asking the model");
  assert.deepEqual(again.data[0], vector(6));
  await second.run(MEANING_MODEL, { text: ["other"] });
  assert.equal(calls, 2, "a text nobody embedded yet is asked for once");
});
