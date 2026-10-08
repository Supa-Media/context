/**
 * THE AI GATEWAY ROAD, CHECKED ON ITS OWN.
 *
 * `src/agent/aiGateway.js` is the one road for the Claude models we pay for:
 * the plan's credit key first, Cloudflare's Unified Billing once that credit is
 * spent. These checks pin what the module promises, with a fake `fetchImpl`
 * that records every request's URL, headers and body:
 *
 *  - configuration is refused unless every id has the shape the address is
 *    built from, so no request can be pointed anywhere else;
 *  - the credit key is sent only where the rules say, and a spent credit rests
 *    for fifteen minutes before it is asked again;
 *  - an error is a phrase: no body text, key or question reaches it;
 *  - the body carries prompt caching on the parts every round repeats, and the
 *    usage it reports is the four counts the meter takes;
 *  - the labels filed with each call are ids only, at most five.
 *
 * Its end-to-end half (a texted turn through `/agent`) is in agentBuiltin.test.mjs.
 */

import {
  aiGatewayConfig,
  gatewayBody,
  isGatewayModel,
  requestViaGateway,
  resetCreditState,
} from "../src/agent/aiGateway.js";
import { ProviderError } from "../src/agent/providers.js";
import { builtinModel, DEFAULT_BUILTIN_MODEL, DEFAULT_GATEWAY_MODEL, hasBuiltinModel } from "../src/agent/builtin.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const GATEWAY_ID = "context-gw";
const TOKEN = `gw-token-${"a".repeat(20)}`;
const CREDIT = `sk-ant-credit-fixture-${"0".repeat(12)}`;
const QUESTION = "SECRET-QUESTION-MARKER: when is the launch";
const BODY_MARKER = "SECRET-BODY-MARKER";
const URL_EXPECTED = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/anthropic/v1/messages`;
const CREDIT_SPENT = {
  error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
};
const T0 = 1_800_000_000_000;
const FIFTEEN_MINUTES = 15 * 60_000;

const CALL = {
  model: "anthropic/claude-haiku-5-5",
  system: "You are the fixture.",
  messages: [{ role: "user", text: QUESTION }],
  tools: [],
};

function env(overrides = {}) {
  return { AI_GATEWAY_ACCOUNT_ID: ACCOUNT_ID, AI_GATEWAY_ID: GATEWAY_ID, AI_GATEWAY_TOKEN: TOKEN, ...overrides };
}

/** A fetch that answers from a script and records every request it was sent. */
function scripted(replies) {
  const queue = [...replies];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: { ...init.headers }, body: JSON.parse(init.body) });
    const next = queue.shift();
    if (!next) throw new Error("fixture: the script ran out");
    const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

function answer(text, { toolUses = [], usage } = {}) {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const tool of toolUses) content.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    content,
    stop_reason: toolUses.length > 0 ? "tool_use" : "end_turn",
    usage: usage ?? { input_tokens: 10, output_tokens: 5 },
  };
}

async function failureOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function runAgentGatewayChecks(check) {
  /* ---------------- configuration ---------------- */

  check(
    "no environment, or an empty one, has no gateway",
    aiGatewayConfig(undefined) === null && aiGatewayConfig({}) === null && aiGatewayConfig(env({ AI_GATEWAY_TOKEN: undefined })) === null,
  );
  for (const key of ["AI_GATEWAY_ACCOUNT_ID", "AI_GATEWAY_ID", "AI_GATEWAY_TOKEN"]) {
    check(`a gateway missing ${key} is not configured`, aiGatewayConfig(env({ [key]: undefined })) === null);
  }

  const badAccounts = [
    "0123456789ABCDEF0123456789ABCDEF",
    "0123456789abcdef0123456789abcde",
    "0123456789abcdef0123456789abcdef0",
    "../x",
    "a/b",
    "evil.com#",
    "0123456789abcdef0123456789abcdef?x=1",
    "0123456789abcdef0123456789abcdef\n",
    " 0123456789abcdef0123456789abcdef",
    12345,
  ];
  check(
    "an account id that is not 32 lowercase hex, or has path or URL characters, is refused",
    badAccounts.every((id) => aiGatewayConfig(env({ AI_GATEWAY_ACCOUNT_ID: id })) === null),
  );

  const badGateways = ["../x", "a/b", "evil.com#", "Upper", "-leading", "a".repeat(65), "", "gw?x", "gw\n", 7];
  check(
    "a gateway id outside the slug shape is refused",
    badGateways.every((id) => aiGatewayConfig(env({ AI_GATEWAY_ID: id })) === null),
  );
  check(
    "a one-character, a hyphenated and a 64-character gateway id are accepted",
    aiGatewayConfig(env({ AI_GATEWAY_ID: "a" })) !== null &&
      aiGatewayConfig(env({ AI_GATEWAY_ID: "context-gw-1" })) !== null &&
      aiGatewayConfig(env({ AI_GATEWAY_ID: "a".repeat(64) })) !== null,
  );

  check("a token of 19 characters is refused", aiGatewayConfig(env({ AI_GATEWAY_TOKEN: "t".repeat(19) })) === null);
  check(
    "a token of 20 and of 512 characters is accepted, one of 513 is refused",
    aiGatewayConfig(env({ AI_GATEWAY_TOKEN: "t".repeat(20) })) !== null &&
      aiGatewayConfig(env({ AI_GATEWAY_TOKEN: "t".repeat(512) })) !== null &&
      aiGatewayConfig(env({ AI_GATEWAY_TOKEN: "t".repeat(513) })) === null,
  );

  const plain = aiGatewayConfig(env());
  check("the credit key is optional: without it the gateway is configured, with no key", plain !== null && plain.creditKey === null);
  check(
    "a credit key that is too short, too long or not a string is ignored rather than used",
    aiGatewayConfig(env({ ANTHROPIC_CREDIT_KEY: "short" }))?.creditKey === null &&
      aiGatewayConfig(env({ ANTHROPIC_CREDIT_KEY: "k".repeat(513) }))?.creditKey === null &&
      aiGatewayConfig(env({ ANTHROPIC_CREDIT_KEY: 42 }))?.creditKey === null,
  );
  const keyed = aiGatewayConfig(env({ ANTHROPIC_CREDIT_KEY: CREDIT }));
  check("a credit key of a plausible length is kept", keyed?.creditKey === CREDIT && keyed?.token === TOKEN);
  check(
    "the address is exactly the Anthropic messages route under our account and gateway",
    plain?.url === URL_EXPECTED && keyed?.url === URL_EXPECTED,
  );
  check(
    "a model is a gateway model only when it is anthropic/claude-*",
    isGatewayModel("anthropic/claude-haiku-5-5") &&
      isGatewayModel("anthropic/claude-sonnet-5-5") &&
      !isGatewayModel("@cf/zai-org/glm-4.7-flash") &&
      !isGatewayModel("openai/gpt-5") &&
      !isGatewayModel("anthropic/claude-") &&
      !isGatewayModel("anthropic/haiku-5-5") &&
      !isGatewayModel("anthropic/claude-haiku-5-5/../x") &&
      !isGatewayModel("anthropic/claude-haiku-5-5?x=1") &&
      !isGatewayModel("claude-haiku-5-5") &&
      !isGatewayModel(undefined),
  );

  /* ---------------- the credit key and Unified Billing ---------------- */

  const cfg = aiGatewayConfig(env({ ANTHROPIC_CREDIT_KEY: CREDIT }));

  resetCreditState();
  const first = scripted([{ status: 200, body: answer("from the plan") }]);
  const paid = await requestViaGateway(CALL, cfg, { fetchImpl: first.fetchImpl, now: () => T0 });
  check(
    "with a credit key, the first call carries it, the gateway token, and collect-log off, and is paid by the credit",
    first.calls.length === 1 &&
      first.calls[0].url === URL_EXPECTED &&
      first.calls[0].headers["x-api-key"] === CREDIT &&
      first.calls[0].headers["cf-aig-authorization"] === `Bearer ${TOKEN}` &&
      first.calls[0].headers["cf-aig-collect-log"] === "false" &&
      paid.paidBy === "credit" &&
      paid.text === "from the plan",
  );

  resetCreditState();
  const spent = scripted([
    { status: 400, body: CREDIT_SPENT },
    { status: 200, body: answer("from cloudflare") },
  ]);
  const second = await requestViaGateway(CALL, cfg, { fetchImpl: spent.fetchImpl, now: () => T0 });
  check(
    "a spent credit is retried without the key at once, and the answer is paid by Unified Billing",
    spent.calls.length === 2 &&
      spent.calls[0].headers["x-api-key"] === CREDIT &&
      !("x-api-key" in spent.calls[1].headers) &&
      second.paidBy === "cloudflare" &&
      second.text === "from cloudflare",
  );

  const restWithin = scripted([{ status: 200, body: answer("still resting") }]);
  const third = await requestViaGateway(CALL, cfg, { fetchImpl: restWithin.fetchImpl, now: () => T0 + FIFTEEN_MINUTES - 1 });
  check(
    "a call a moment short of fifteen minutes later skips the key entirely: one fetch, no x-api-key",
    restWithin.calls.length === 1 && !("x-api-key" in restWithin.calls[0].headers) && third.paidBy === "cloudflare",
  );

  const afterRest = scripted([{ status: 200, body: answer("the plan again") }]);
  const fourth = await requestViaGateway(CALL, cfg, { fetchImpl: afterRest.fetchImpl, now: () => T0 + FIFTEEN_MINUTES + 1 });
  check(
    "after fifteen minutes the key is tried again, and a credit that answers is paid by the credit",
    afterRest.calls.length === 1 && afterRest.calls[0].headers["x-api-key"] === CREDIT && fourth.paidBy === "credit",
  );

  resetCreditState();
  const payment402 = scripted([
    { status: 402, body: { error: "payment_required" } },
    { status: 200, body: answer("no key") },
  ]);
  await requestViaGateway(CALL, cfg, { fetchImpl: payment402.fetchImpl, now: () => T0 });
  const during402 = scripted([{ status: 200, body: answer("skipped") }]);
  await requestViaGateway(CALL, cfg, { fetchImpl: during402.fetchImpl, now: () => T0 + 1 });
  check(
    "a 402 from the key rests the credit the same way a spent balance does",
    payment402.calls.length === 2 && during402.calls.length === 1 && !("x-api-key" in during402.calls[0].headers),
  );

  resetCreditState();
  const unauthorized = scripted([
    { status: 401, body: { error: { message: "invalid x-api-key" } } },
    { status: 200, body: answer("no key") },
    { status: 200, body: answer("keyed again") },
  ]);
  const retried = await requestViaGateway(CALL, cfg, { fetchImpl: unauthorized.fetchImpl, now: () => T0 });
  const next = await requestViaGateway(CALL, cfg, { fetchImpl: unauthorized.fetchImpl, now: () => T0 + 1000 });
  check(
    "a 401 from the key is retried once without it, and does not rest: the next call tries the key again",
    unauthorized.calls.length === 3 &&
      unauthorized.calls[0].headers["x-api-key"] === CREDIT &&
      !("x-api-key" in unauthorized.calls[1].headers) &&
      unauthorized.calls[2].headers["x-api-key"] === CREDIT &&
      retried.paidBy === "cloudflare" &&
      next.paidBy === "credit",
  );

  resetCreditState();
  const forbidden = scripted([
    { status: 403, body: { error: { message: "forbidden" } } },
    { status: 200, body: answer("no key") },
    { status: 200, body: answer("keyed again") },
  ]);
  const forbiddenRetried = await requestViaGateway(CALL, cfg, { fetchImpl: forbidden.fetchImpl, now: () => T0 });
  const forbiddenNext = await requestViaGateway(CALL, cfg, { fetchImpl: forbidden.fetchImpl, now: () => T0 + 1000 });
  check(
    "a 403 from the key is retried once without it, and does not rest: the next call tries the key again",
    forbidden.calls.length === 3 &&
      forbidden.calls[0].headers["x-api-key"] === CREDIT &&
      !("x-api-key" in forbidden.calls[1].headers) &&
      forbidden.calls[2].headers["x-api-key"] === CREDIT &&
      forbiddenRetried.paidBy === "cloudflare" &&
      forbiddenNext.paidBy === "credit",
  );

  resetCreditState();
  const rest402 = scripted([
    { status: 402, body: { error: "payment_required" } },
    { status: 200, body: answer("no key") },
    { status: 200, body: answer("still resting") },
    { status: 200, body: answer("the plan again") },
  ]);
  await requestViaGateway(CALL, cfg, { fetchImpl: rest402.fetchImpl, now: () => T0 });
  await requestViaGateway(CALL, cfg, { fetchImpl: rest402.fetchImpl, now: () => T0 + FIFTEEN_MINUTES - 1 });
  await requestViaGateway(CALL, cfg, { fetchImpl: rest402.fetchImpl, now: () => T0 + FIFTEEN_MINUTES + 1 });
  check(
    "a 402 from the key rests the credit for exactly fifteen minutes: skipped a moment short of it, tried again just after",
    rest402.calls.length === 4 &&
      rest402.calls[0].headers["x-api-key"] === CREDIT &&
      !("x-api-key" in rest402.calls[1].headers) &&
      !("x-api-key" in rest402.calls[2].headers) &&
      rest402.calls[3].headers["x-api-key"] === CREDIT,
  );

  resetCreditState();
  const badRequest400 = scripted([
    { status: 400, body: { error: { message: `invalid request quoting ${QUESTION}` } } },
    { status: 200, body: answer("must not be asked") },
  ]);
  const refused400 = await failureOf(requestViaGateway(CALL, cfg, { fetchImpl: badRequest400.fetchImpl, now: () => T0 }));
  check(
    "a 400 that does not say the credit is spent, sent with the key, is a ProviderError after one fetch: no keyless retry",
    refused400 instanceof ProviderError &&
      refused400.status === 400 &&
      badRequest400.calls.length === 1 &&
      badRequest400.calls[0].headers["x-api-key"] === CREDIT &&
      !String(refused400.message).includes("SECRET-QUESTION-MARKER"),
  );

  resetCreditState();
  const serverError = scripted([{ status: 500, body: { error: { message: `internal ${QUESTION} key ${CREDIT}` } } }]);
  const keyed500 = await failureOf(requestViaGateway(CALL, cfg, { fetchImpl: serverError.fetchImpl, now: () => T0 }));
  check(
    "a 500 with the key is a ProviderError with the status, and is not retried",
    keyed500 instanceof ProviderError && keyed500.status === 500 && serverError.calls.length === 1,
  );

  resetCreditState();
  const bare500 = scripted([{ status: 500, body: "upstream exploded" }]);
  const unkeyed500 = await failureOf(requestViaGateway(CALL, plain, { fetchImpl: bare500.fetchImpl, now: () => T0 }));
  check(
    "a 500 without a key is a ProviderError, one fetch",
    unkeyed500 instanceof ProviderError && unkeyed500.status === 500 && bare500.calls.length === 1,
  );

  resetCreditState();
  const solo = scripted([{ status: 200, body: answer("unkeyed") }]);
  const soloResult = await requestViaGateway(CALL, plain, { fetchImpl: solo.fetchImpl, now: () => T0 });
  check(
    "with no credit key configured, one call is made without x-api-key, paid by Unified Billing",
    solo.calls.length === 1 &&
      !("x-api-key" in solo.calls[0].headers) &&
      solo.calls[0].headers["cf-aig-authorization"] === `Bearer ${TOKEN}` &&
      solo.calls[0].headers["cf-aig-collect-log"] === "false" &&
      soloResult.paidBy === "cloudflare",
  );

  /* ---------------- errors are phrases ---------------- */

  resetCreditState();
  const leaky = scripted([
    { status: 500, body: `{"error":{"message":"${BODY_MARKER} quoted ${QUESTION} with key ${CREDIT}"}}` },
  ]);
  const leakedStatus = await failureOf(requestViaGateway(CALL, cfg, { fetchImpl: leaky.fetchImpl, now: () => T0 }));
  const leakText = JSON.stringify({
    message: leakedStatus?.message,
    reason: leakedStatus?.reason,
    stack: leakedStatus?.stack,
    error: String(leakedStatus),
  });
  check(
    "an error from a provider's body never carries its text, the key or the question into the error",
    leakedStatus instanceof ProviderError &&
      !leakText.includes(BODY_MARKER) &&
      !leakText.includes(CREDIT) &&
      !leakText.includes("SECRET-QUESTION-MARKER"),
  );

  resetCreditState();
  const transportFailure = await failureOf(
    requestViaGateway(CALL, cfg, {
      fetchImpl: async (url, init) => {
        throw new Error(`socket closed sending ${url} ${JSON.stringify(init.headers)} ${init.body}`);
      },
      now: () => T0,
    }),
  );
  const transportText = JSON.stringify({
    message: transportFailure?.message,
    reason: transportFailure?.reason,
    stack: transportFailure?.stack,
  });
  check(
    "a transport error that quotes the request is replaced by a fixed phrase, so the key and question stay out",
    transportFailure instanceof ProviderError &&
      transportFailure.reason === "gateway request failed" &&
      !transportText.includes(CREDIT) &&
      !transportText.includes("SECRET-QUESTION-MARKER"),
  );

  resetCreditState();
  const refusedBody = scripted([
    { status: 401, body: { error: { message: `bad key ${CREDIT}` } } },
    { status: 400, body: `{"error":{"message":"${BODY_MARKER} ${QUESTION}"}}` },
  ]);
  const twice = await failureOf(requestViaGateway(CALL, cfg, { fetchImpl: refusedBody.fetchImpl, now: () => T0 }));
  const twiceText = JSON.stringify({ message: twice?.message, reason: twice?.reason, stack: twice?.stack });
  check(
    "a refusal of the key and then of the retry leaves a status-only error, with no body text",
    twice instanceof ProviderError &&
      twice.status === 400 &&
      !twiceText.includes(BODY_MARKER) &&
      !twiceText.includes(CREDIT) &&
      !twiceText.includes("SECRET-QUESTION-MARKER"),
  );

  /* ---------------- the round's deadline covers reading the body ---------------- */

  // The round timer is 60 seconds and not exported, so the check fires it at
  // once: the global setTimeout is wrapped so that only the 60-second timer is
  // moved to a zero-delay real timer, and every other timer is left alone. The
  // fake body never finishes on its own. It waits for the request's signal and
  // rejects when that signal aborts, as a real body read does. A two-second
  // safety timer makes a body that is not cut short fail the check instead of
  // hanging the suite, and the wrapper is restored in `finally` either way.
  resetCreditState();
  const realSetTimeout = globalThis.setTimeout;
  let bodyCutShort = false;
  let requestSignal = null;
  globalThis.setTimeout = (fn, ms, ...rest) => (ms === 60_000 ? realSetTimeout(fn, 0) : realSetTimeout(fn, ms, ...rest));
  let stalled;
  try {
    stalled = await failureOf(
      requestViaGateway(CALL, plain, {
        now: () => T0,
        fetchImpl: async (_url, init) => {
          requestSignal = init.signal;
          return {
            status: 200,
            text: () =>
              new Promise((resolve, reject) => {
                const safety = realSetTimeout(() => reject(new Error("body was never cut short")), 2000);
                const abort = () => {
                  clearTimeout(safety);
                  bodyCutShort = true;
                  reject(new Error("body aborted"));
                };
                if (init.signal.aborted) abort();
                else init.signal.addEventListener("abort", abort, { once: true });
              }),
          };
        },
      }),
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  check(
    "a body that never finishes is cut short by the round's deadline: a ProviderError, not a hang",
    stalled instanceof ProviderError && bodyCutShort && requestSignal?.aborted === true,
  );

  /* ---------------- model and config refusals make no call ---------------- */

  const refusedModels = [
    "@cf/zai-org/glm-4.7-flash",
    "openai/gpt-5",
    "anthropic/claude-",
    "anthropic/haiku-5-5",
    "anthropic/claude-haiku-5-5/../x",
    "anthropic/claude-haiku-5-5?x=1",
  ];
  let modelRefusals = 0;
  let modelFetches = 0;
  for (const model of refusedModels) {
    const probe = scripted([{ status: 200, body: answer("should not be asked") }]);
    const refusal = await failureOf(requestViaGateway({ ...CALL, model }, cfg, { fetchImpl: probe.fetchImpl, now: () => T0 }));
    if (refusal instanceof ProviderError) modelRefusals += 1;
    modelFetches += probe.calls.length;
  }
  check(
    "a model that is not anthropic/claude-* is a ProviderError, and no request is made for it",
    modelRefusals === refusedModels.length && modelFetches === 0,
  );
  check(
    "a missing gateway is a ProviderError with no request",
    (await failureOf(requestViaGateway(CALL, null, { fetchImpl: async () => { throw new Error("called"); }, now: () => T0 }))) instanceof ProviderError,
  );

  /* ---------------- the body ---------------- */

  const shaped = gatewayBody({
    model: "anthropic/claude-haiku-5-5",
    system: "SYSTEM-TEXT",
    messages: [
      { role: "user", text: "first question" },
      { role: "assistant", text: "thinking", toolCalls: [{ id: "toolu_1", name: "read_note", args: { path: "a.md" } }] },
      { role: "tool", id: "toolu_1", text: "contents" },
      { role: "user", text: "last question" },
    ],
    tools: [
      { name: "read_note", description: "Reads a note", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "search", description: "Searches" },
    ],
  });
  check("the body names the model without its anthropic/ prefix", shaped.model === "claude-haiku-5-5" && shaped.max_tokens === 2048);
  check(
    "the system prompt is one text block carrying an ephemeral cache breakpoint",
    Array.isArray(shaped.system) &&
      shaped.system.length === 1 &&
      shaped.system[0].type === "text" &&
      shaped.system[0].text === "SYSTEM-TEXT" &&
      same(shaped.system[0].cache_control, { type: "ephemeral" }),
  );
  check(
    "tools are mapped to input_schema, the last carries the cache breakpoint, and a schema-less tool gets an object schema",
    shaped.tools.length === 2 &&
      same(shaped.tools[0].input_schema, { type: "object", properties: { path: { type: "string" } } }) &&
      shaped.tools[0].cache_control === undefined &&
      same(shaped.tools[1].input_schema, { type: "object" }) &&
      same(shaped.tools[1].cache_control, { type: "ephemeral" }) &&
      !("inputSchema" in shaped.tools[0]),
  );
  const lastWire = shaped.messages[shaped.messages.length - 1];
  check(
    "the last message's last block carries the cache breakpoint, and no earlier block does",
    lastWire.role === "user" &&
      same(lastWire.content[lastWire.content.length - 1].cache_control, { type: "ephemeral" }) &&
      JSON.stringify(shaped.messages).split('"cache_control"').length - 1 === 1,
  );
  check(
    "tool answers are grouped into one user turn as tool_result blocks, and the grouping flag never reaches the wire",
    shaped.messages[2].role === "user" &&
      shaped.messages[2].content[0].type === "tool_result" &&
      shaped.messages[2].content[0].tool_use_id === "toolu_1" &&
      shaped.messages[1].content.some((block) => block.type === "tool_use" && same(block.input, { path: "a.md" })) &&
      !JSON.stringify(shaped).includes("pendingTools"),
  );
  const bare = gatewayBody({ model: "anthropic/claude-haiku-5-5", system: "", messages: [{ role: "user", text: "q" }], tools: [] });
  check("no system and no tools: neither key is sent", bare.system === undefined && bare.tools === undefined);

  resetCreditState();
  const wire = scripted([{ status: 200, body: answer("ok") }]);
  await requestViaGateway(
    { model: "anthropic/claude-sonnet-5-5", system: "s", messages: [{ role: "user", text: "q" }], tools: [{ name: "t", description: "d" }] },
    plain,
    { fetchImpl: wire.fetchImpl, now: () => T0 },
  );
  check(
    "the body on the wire is the body gatewayBody builds, and a sonnet model is named without its prefix",
    wire.calls[0].body.model === "claude-sonnet-5-5" &&
      same(wire.calls[0].body.tools, [{ name: "t", description: "d", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }]),
  );

  /* ---------------- the answer ---------------- */

  resetCreditState();
  const counted = scripted([
    {
      status: 200,
      body: answer("", {
        toolUses: [{ id: "toolu_9", name: "read_note", input: { path: "x.md" } }],
        usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
      }),
    },
  ]);
  const usageResult = await requestViaGateway(CALL, plain, { fetchImpl: counted.fetchImpl, now: () => T0 });
  check(
    "the four token counts are read as input, output, cacheRead and cacheWrite, and the tool call is parsed",
    same(usageResult.usage, { input: 11, output: 7, cacheRead: 300, cacheWrite: 40 }) &&
      same(usageResult.toolCalls, [{ id: "toolu_9", name: "read_note", args: { path: "x.md" } }]) &&
      usageResult.stop === "tool_use",
  );

  resetCreditState();
  const sparse = scripted([{ status: 200, body: { content: [{ type: "text", text: "x" }] } }]);
  const sparseResult = await requestViaGateway(CALL, plain, { fetchImpl: sparse.fetchImpl, now: () => T0 });
  check("an answer with no usage block counts as zero, not as an error", same(sparseResult.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));

  resetCreditState();
  const odd = scripted([
    { status: 200, body: { content: [], usage: { input_tokens: -5, output_tokens: 3.9, cache_read_input_tokens: "7", cache_creation_input_tokens: null } } },
  ]);
  const oddResult = await requestViaGateway(CALL, plain, { fetchImpl: odd.fetchImpl, now: () => T0 });
  check(
    "negative, fractional, string and null counts are clamped to whole non-negative numbers or zero",
    same(oddResult.usage, { input: 0, output: 3, cacheRead: 0, cacheWrite: 0 }),
  );

  /* ---------------- the labels filed with each call ---------------- */

  resetCreditState();
  const labelled = scripted([{ status: 200, body: answer("ok") }]);
  await requestViaGateway(CALL, plain, {
    fetchImpl: labelled.fetchImpl,
    now: () => T0,
    metadata: {
      workspace: "ws_texter",
      grant: "g-1.a:b",
      "bad key": "x",
      Caps: "y",
      count: 5,
      note: "has space",
      path: "1-projects/a.md",
      long: "a".repeat(129),
      alpha: "1",
      beta: "2",
      gamma: "3",
      delta: "4",
      epsilon: "5",
      zeta: "6",
    },
  });
  const sent = labelled.calls[0].headers["cf-aig-metadata"];
  check(
    "the metadata header keeps the first five valid labels, drops invalid keys and values, and nothing else",
    typeof sent === "string" &&
      same(JSON.parse(sent), { workspace: "ws_texter", grant: "g-1.a:b", alpha: "1", beta: "2", gamma: "3" }),
  );

  resetCreditState();
  const unlabelled = scripted([{ status: 200, body: answer("ok") }, { status: 200, body: answer("ok") }]);
  await requestViaGateway(CALL, plain, { fetchImpl: unlabelled.fetchImpl, now: () => T0 });
  await requestViaGateway(CALL, plain, { fetchImpl: unlabelled.fetchImpl, now: () => T0, metadata: { path: "a/b", count: 1 } });
  check(
    "no metadata, or metadata that is all invalid, sends no metadata header",
    !("cf-aig-metadata" in unlabelled.calls[0].headers) && !("cf-aig-metadata" in unlabelled.calls[1].headers),
  );

  /* ---------------- which model the built-in turn uses ---------------- */

  const gatewayOnly = env();
  check(
    "without a gateway the built-in model is GLM on Workers AI, even if Haiku is named",
    builtinModel({ AGENT_BUILTIN_MODEL: "anthropic/claude-haiku-5-5" }) === DEFAULT_BUILTIN_MODEL &&
      builtinModel({}) === DEFAULT_BUILTIN_MODEL,
  );
  check(
    "a gateway with no model named makes Haiku the built-in model",
    builtinModel(gatewayOnly) === "anthropic/claude-haiku-5-5" && DEFAULT_GATEWAY_MODEL === "anthropic/claude-haiku-5-5",
  );
  check(
    "a gateway with a Workers AI model named keeps that model",
    builtinModel({ ...gatewayOnly, AGENT_BUILTIN_MODEL: "@cf/x/y" }) === "@cf/x/y",
  );
  check(
    "a gateway with an anthropic/claude model named uses it",
    builtinModel({ ...gatewayOnly, AGENT_BUILTIN_MODEL: "anthropic/claude-sonnet-5-5" }) === "anthropic/claude-sonnet-5-5",
  );
  check(
    "a gateway with a model it cannot call falls back to Haiku",
    builtinModel({ ...gatewayOnly, AGENT_BUILTIN_MODEL: "openai/gpt" }) === "anthropic/claude-haiku-5-5",
  );
  check(
    "a gateway whose token is too short is no gateway, so GLM stays the default",
    builtinModel({ ...gatewayOnly, AI_GATEWAY_TOKEN: "short", AGENT_BUILTIN_MODEL: "anthropic/claude-haiku-5-5" }) === DEFAULT_BUILTIN_MODEL,
  );
  check(
    "a built-in model exists with a gateway alone, with Workers AI alone, or with both; with neither there is none",
    hasBuiltinModel(gatewayOnly) === true &&
      hasBuiltinModel({ AI: { run: async () => ({}) } }) === true &&
      hasBuiltinModel({ ...gatewayOnly, AI: { run: async () => ({}) } }) === true &&
      hasBuiltinModel({}) === false &&
      hasBuiltinModel({ AI: {} }) === false &&
      hasBuiltinModel({ AI_GATEWAY_TOKEN: "short" }) === false &&
      hasBuiltinModel(undefined) === false,
  );

  resetCreditState();
}
