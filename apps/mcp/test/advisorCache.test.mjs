/**
 * THE ADVISOR CACHES ITS INSTRUCTIONS, NEVER ITS BRIEF.
 *
 * The AI Gateway logs (1-18 November) showed every advisor ask writing its whole brief to the prompt cache at 1.25x,
 * and nothing ever reading it back: each brief is new. Only the stable prefix (the map and the role's instructions)
 * was being read. So an advisor call's system prompt keeps its five-minute mark, and its one user message goes
 * unmarked (`cacheTail: false`, `advisorRoles/core.js`). These tests hold that the prefix is the same bytes across
 * two different turns, and that the brief is the part that changes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ADVISOR_PROMPT, advisorBrief } from "../src/agent/advisor.js";
import { adviseOnce } from "../src/agent/advisorRoles/core.js";
import { JOB_CHECK_PROMPT } from "../src/agent/advisorRoles/jobCheck.js";
import { requestBuiltin } from "../src/agent/builtin.js";
import { aiGatewayConfig, gatewayBody, resetCreditState, resetHourMarks } from "../src/agent/aiGateway.js";

const MODEL = "anthropic/claude-sonnet-5-5";
const DAY_ONE = Date.parse("2026-11-17T10:00:00Z");
const DAY_TWO = Date.parse("2026-11-18T10:00:00Z");
const LIVE = { about: "Likes short replies.", now: "Tuesday, mid-morning." };
const TURN_ONE = [{ role: "user", text: "when is the dentist" }, { role: "assistant", text: "Tuesday at 3." }];
const TURN_TWO = [{ role: "user", text: "move it to Thursday" }, { role: "assistant", text: "Moved to Thursday at 11." }];

const OK = { status: 200, body: { id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } };

const marks = (value) => {
  const found = [];
  JSON.parse(JSON.stringify(value), (key, mark) => (key === "cache_control" ? (found.push(mark), mark) : mark));
  return found;
};

const prefixOf = (body) => JSON.stringify({ model: body.model, max_tokens: body.max_tokens, system: body.system, tools: body.tools, output_config: body.output_config, thinking: body.thinking });

function env() {
  return { AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", AI_GATEWAY_ID: "gw", AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}` };
}

/** Each ask goes through the real path: adviseOnce -> requestBuiltin -> requestViaGateway -> gatewayBody. */
async function askTwice({ role, prompt, briefs, times }) {
  resetCreditState();
  resetHourMarks();
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify(OK.body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const config = aiGatewayConfig(env());
  for (let i = 0; i < briefs.length; i += 1) {
    const now = times[i];
    await adviseOnce({
      request: (params) => requestBuiltin(params, null, { gateway: config, fetchImpl, now: () => now }),
      model: MODEL,
      effort: "high",
      prompt,
      role,
      brief: briefs[i],
    });
  }
  resetHourMarks();
  return sent;
}

test("the advisor's request prefix is byte-identical across two turns, its system marked and its brief not", async () => {
  const briefs = [advisorBrief(LIVE, TURN_ONE), advisorBrief(LIVE, TURN_TWO)];
  const [first, second] = await askTwice({ role: "advisor", prompt: ADVISOR_PROMPT, briefs, times: [DAY_ONE, DAY_TWO] });

  assert.equal(prefixOf(first), prefixOf(second), "everything but the messages is the same bytes");
  assert.ok(first.system.length > 0, "the instructions are sent as the system prompt");
  assert.deepEqual(first.system.at(-1).cache_control, { type: "ephemeral" }, "the prefix keeps its five-minute mark, no ttl");
  assert.equal(first.tools, undefined, "no tools offered");
  assert.deepEqual(marks(first.messages), [], "no cache mark anywhere in the brief");
  assert.deepEqual(marks(second.messages), [], "no cache mark on the second turn's brief either");
  assert.notEqual(JSON.stringify(first.messages), JSON.stringify(second.messages), "the two turns were different");
  assert.ok(JSON.stringify(first.messages).includes("Every date you read or write is worked out from this."), "the date line went into the message");
  assert.ok(!JSON.stringify(first.system).includes("Every date you read or write"), "and not into the system prompt");
  assert.ok(!JSON.stringify(second.system).includes("Every date you read or write"), "nor on the second ask");
});

test("the job check's request prefix is byte-identical across two briefs, its system marked and its brief not", async () => {
  const briefs = ["The job: book the dentist. Finish line: a confirmation.", "The job: book the dentist. Part two: the reply."];
  const [first, second] = await askTwice({ role: "jobCheck", prompt: JOB_CHECK_PROMPT, briefs, times: [DAY_ONE, DAY_TWO] });

  assert.equal(prefixOf(first), prefixOf(second));
  assert.deepEqual(first.system.at(-1).cache_control, { type: "ephemeral" });
  assert.deepEqual(marks(first.messages), []);
  assert.deepEqual(marks(second.messages), []);
  assert.notEqual(JSON.stringify(first.messages), JSON.stringify(second.messages));
});

test("a one-off call that names no cacheTail still marks its last block", () => {
  const body = gatewayBody({ model: MODEL, system: "Judge this.", messages: [{ role: "user", text: "a reply" }], tools: [] });
  assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" }, "other callers are unchanged");
});

test("a layered call with cacheTail false is byte-identical to one without it", () => {
  const layered = {
    model: MODEL,
    system: { stable: "You are Tex.", context: "About them: likes short replies." },
    messages: [...TURN_ONE, { role: "user", text: "and Monday?" }],
    tools: [{ name: "read_note", description: "read", inputSchema: { type: "object" } }],
    cachedThrough: TURN_ONE.length,
  };
  assert.deepEqual(gatewayBody({ ...layered, cacheTail: false }), gatewayBody(layered));
});
