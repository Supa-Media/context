/**
 * THE PROMPT CACHE READS THE SAME BYTES TEXT AFTER TEXT.
 *
 * Production, 2026-10-31: a texted turn re-sent about 58,000 tokens as new on
 * every text, because the system prompt carried the clock, what earlier texts
 * used and the model answering, and those changed each time. The cache reads a
 * prefix only where it matches, so the request is now laid out least volatile
 * first (`aiGateway.js`, `turn.js`):
 *
 *   tools → system.stable → system.context → history (all 5-minute marks) → the new text + its preamble
 *
 * These checks send two texts of one chat, eleven minutes apart, through
 * `runTurn` to a fake gateway and read the bodies on the wire:
 *
 *  - the bytes up to the history's breakpoint are the same from one text to the next;
 *  - the clock, the model line and the "what you did" list are said in the
 *    person's turn, never in the cached prefix, and the model still has the time;
 *  - there are at most four breakpoints, each where the layout says;
 *  - the tools are offered in one fixed order, whatever order they were granted in;
 *  - every mark is the default five-minute one (a one-hour TTL is unproven through AI Gateway).
 *
 * Sabotage (run by hand while writing this): moving `localNowPrompt` back into
 * the system prompt, dropping `cachedThrough`, offering the tools reversed, and
 * adding a TTL each fail a check here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { aiGatewayConfig, resetCreditState } from "../src/agent/aiGateway.js";
import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";

const ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}`,
};
const HAIKU = "anthropic/claude-haiku-5-5";
const TIME_ZONE = "America/New_York";
// Saturday, October 31, 2026, 12:24 pm and 12:35 pm in New York: the two texts in the production log.
const FIRST_TEXT = Date.UTC(2026, 9, 31, 16, 24);
const SECOND_TEXT = FIRST_TEXT + 11 * 60_000;
const ABOUT_ME = "- Prefers short texts.\n- Works on the glue-up schedule with Dana.";

const HISTORY = [
  { role: "user", text: "what did I decide about the glue-up?" },
  { role: "assistant", text: "You moved it to the 26th.", tools: ["read_note"] },
];
// The second text's history: the first exchange, then one more that used a search.
const HISTORY_LATER = [
  ...HISTORY,
  { role: "user", text: "remind me to sleep in 2 minutes" },
  { role: "assistant", text: "Set for 12:26.", tools: ["search_notes"] },
];

const tool = (name) => ({ name, description: `${name} does its thing.`, inputSchema: { type: "object", properties: {} } });
const TOOLS = [tool("orient"), tool("search_notes"), tool("read_note"), tool("write_note")];

function answer(text) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/** One texted turn through the gateway; returns the request it sent (headers and body). */
async function sendText({ now, question, history, tools = TOOLS }) {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push({ headers: { ...init.headers }, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(answer("Done.")), { status: 200, headers: { "content-type": "application/json" } });
  };
  resetCreditState();
  await runTurn({
    question,
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    history,
    tools,
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl },
    builtinModelOverride: HAIKU,
    texting: true,
    aboutMe: ABOUT_ME,
    localNow: { now, timeZone: TIME_ZONE },
  });
  assert.equal(sent.length, 1, "one text, one round");
  return sent[0];
}

/** The request without the cache marks: the content a breakpoint is read against. */
const unmarked = (value) => JSON.parse(JSON.stringify(value, (key, field) => (key === "cache_control" ? undefined : field)));

/** The text of the request's last user turn: the per-text facts first, then the person's own words. */
function lastUserText(body) {
  const last = body.messages[body.messages.length - 1];
  assert.equal(last.role, "user", "the request ends with the person's text");
  return last.content.map((block) => block.text).join("\n");
}

test("two texts of one chat, minutes apart, send the same bytes up to the history's breakpoint", async () => {
  const first = await sendText({ now: FIRST_TEXT, question: "and what is on tomorrow?", history: HISTORY });
  const second = await sendText({ now: SECOND_TEXT, question: "and what about Monday?", history: HISTORY_LATER });
  const a = first.body;
  const b = second.body;

  assert.deepEqual(a.tools, b.tools, "the tools are the same list");
  assert.deepEqual(a.system, b.system, "the system prompt, stable and context parts, is the same bytes");
  assert.deepEqual(
    unmarked(a.messages.slice(0, HISTORY.length)),
    unmarked(b.messages.slice(0, HISTORY.length)),
    "the history the first text ended on is the same in the second, byte for byte",
  );
  assert.equal(
    JSON.stringify({ tools: a.tools, system: a.system, messages: unmarked(a.messages.slice(0, HISTORY.length)) }),
    JSON.stringify({ tools: b.tools, system: b.system, messages: unmarked(b.messages.slice(0, HISTORY.length)) }),
    "tools, system and history prefix together serialise identically",
  );
});

test("the clock, the model line and the list of earlier tools are said in the person's turn, not the cached prefix", async () => {
  const first = await sendText({ now: FIRST_TEXT, question: "and what is on tomorrow?", history: HISTORY });
  const second = await sendText({ now: SECOND_TEXT, question: "and what about Monday?", history: HISTORY_LATER });
  const systemOf = (body) => body.system.map((block) => block.text).join("");

  for (const body of [first.body, second.body]) {
    assert.doesNotMatch(systemOf(body), /It is now /, "no clock in the system prompt");
    assert.doesNotMatch(systemOf(body), /This answer is written by the AI model/, "no model line in the system prompt");
    assert.doesNotMatch(systemOf(body), /What you did for those earlier texts/, "no earlier-tools list in the system prompt");
  }
  assert.match(lastUserText(first.body), /^Context for this text, not written by them:\n\nIt is now Saturday, October 31, 2026, 12:24 pm where they are \(America\/New_York\)/);
  assert.match(lastUserText(second.body), /It is now Saturday, October 31, 2026, 12:35 pm where they are/);
  assert.match(lastUserText(second.body), /What you did for those earlier texts/, "the earlier tools are still told to the model");
  assert.equal(second.body.messages.at(-1).content.at(-1).text, "and what about Monday?", "the person's own words come last");
});

test("at most four breakpoints, each where the layout puts it, all of them one-hour except the history", async () => {
  const { body } = await sendText({ now: SECOND_TEXT, question: "and what about Monday?", history: HISTORY_LATER });
  const marks = JSON.stringify(body).split('"cache_control"').length - 1;
  assert.ok(marks <= 4, `at most four breakpoints, got ${marks}`);
  assert.equal(marks, 4, "tools, stable system, context system and history");
  assert.deepEqual(body.tools.at(-1).cache_control, { type: "ephemeral" });
  assert.equal(body.tools.slice(0, -1).some((entry) => entry.cache_control !== undefined), false);
  assert.equal(body.system.length, 2, "the stable and the context parts are each a block");
  for (const block of body.system) assert.deepEqual(block.cache_control, { type: "ephemeral" });
  const historyEnd = body.messages[HISTORY_LATER.length - 1];
  assert.deepEqual(historyEnd.content.at(-1).cache_control, { type: "ephemeral" }, "the history's last block, five minutes");
  assert.equal(body.messages.at(-1).content.at(-1).cache_control, undefined, "the new text is uncached");
});

test("the first text of a chat has no history breakpoint and still caches the tools and the system prompt", async () => {
  const { body } = await sendText({ now: FIRST_TEXT, question: "hello", history: [] });
  assert.equal(JSON.stringify(body).split('"cache_control"').length - 1, 3);
  assert.equal(body.messages.at(-1).content.at(-1).cache_control, undefined);
  assert.equal(body.messages.at(-1).content.at(-1).text, "hello");
});

test("the tools are offered in one fixed order, whatever order they were granted in", async () => {
  const forward = await sendText({ now: FIRST_TEXT, question: "q", history: HISTORY, tools: TOOLS });
  const reversed = await sendText({ now: FIRST_TEXT, question: "q", history: HISTORY, tools: [...TOOLS].reverse() });
  const names = forward.body.tools.map((entry) => entry.name);
  assert.deepEqual(names, ["orient", "search", "fetch", "write", "manage"], "the six, in the order the table fixes");
  assert.deepEqual(reversed.body.tools, forward.body.tools, "granted in reverse, offered the same");
});
